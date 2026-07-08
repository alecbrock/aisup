import { randomUUID } from 'node:crypto';
import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { buildWorkerCommand, composeEnvAllowlist, resolveRouting } from './adapter.js';
import type { WorkerLaunchPlan } from './adapter.js';
import { buildClaudeWorkerCommand, parseClaudeResult } from './claude-adapter.js';
import { parseCodexJsonStream, chargeableTokens } from './codex-json.js';
import { buildReviewPrompt } from './review.js';
import type { ReviewerPlanOverride } from './review.js';
import { runCandidateLoop } from './failover.js';
import type { CandidateLoopHooks, CandidateFailureKind } from './failover.js';
import { runWorker, tailOutput } from './runner.js';
import { redactTails } from './redact.js';
import type { WorkerExec, WorkerExecResult } from './runner.js';
import type { validateWorkerOutput } from './validation.js';
import type { reviewWorkerOutput } from './review.js';
import type { mergeWorkerOutput } from './merge.js';
import type { MainTreeSnapshot } from './worktree.js';
import { listWorktrees, orphanWorktrees } from './worktree.js';
import { undoWorkerMerge } from './merge.js';
import { WorkerStore } from './store.js';
import type { WorkersConfig, WorkerAdapterConfig } from '../config/schema.js';
import type { JournalWriter } from '../journal/types.js';
import type { ConcreteCandidate } from '../providers/types.js';
import type { WorkerOutput, WorkerState, WorkerTask, ReviewVerdict, TriedCandidate } from './types.js';

export type WorkerRole = 'implementer' | 'reviewer';

/** Default timeout for a Claude worker/reviewer candidate (no per-candidate adapter timeout). */
const CLAUDE_WORKER_TIMEOUT_SECONDS = 1800;

/** Human/journal label for a candidate: `claude:<account>` or the adapter/provider name. */
function candidateLabel(c: ConcreteCandidate): string {
  return c.provider === 'claude' ? `claude:${c.account ?? '?'}` : c.provider;
}


/** The worktree module surface the orchestrator depends on (injectable for unit tests). */
export interface WorktreeOps {
  resolveBaseSha(opts: { workspaceRoot: string; baseRef: string }): Promise<string>;
  createWorktree(opts: { workspaceRoot: string; worktreeDir: string; baseSha: string; taskId: string }): Promise<string>;
  captureDiff(opts: { worktree: string; baseSha: string }): Promise<{ patch: string; changedFiles: string[] }>;
  snapshotMainTree(opts: { workspaceRoot: string; worktreeDir: string; forbiddenPathGlobs: string[] }): Promise<MainTreeSnapshot>;
  auditBoundary(opts: { workspaceRoot: string; worktreeDir: string; before: MainTreeSnapshot; forbiddenPathGlobs: string[] }): Promise<boolean>;
  sanitizePatch(changedFiles: string[], patch: string, forbiddenGlobs: string[]): { ok: boolean; violations: string[] };
  patchSha256(patch: string): string;
  removeWorktree(opts: { workspaceRoot: string; worktreeDir: string; path: string }): Promise<void>;
  isGitRepo(root: string): Promise<boolean>;
  applyCheck(workspaceRoot: string, patchPath: string): Promise<boolean>;
  applyReverseCheck(workspaceRoot: string, patchPath: string): Promise<boolean>;
}

export interface OrchestratorDeps {
  store: WorkerStore;
  config: WorkersConfig;
  journal: JournalWriter;
  worktreeOps: WorktreeOps;
  /** Subprocess executor for the implementer; omit to use the real shell-free execFile runner. */
  runImplementer?: WorkerExec;
  validateOutput: typeof validateWorkerOutput;
  reviewOutput: typeof reviewWorkerOutput;
  mergeOutput: typeof mergeWorkerOutput;
  resolveActiveSessionCwd: () => string | null;
  /**
   * Resolve a role's ordered candidate list (account-first → cross-LLM). Required in PRODUCTION (the
   * daemon injects it); omit ONLY in single-adapter unit tests, where the orchestrator falls back to
   * the legacy one-candidate path (today's behavior, no failover loop). There is no third state.
   */
  selectCandidates?: (role: WorkerRole, task: WorkerTask, nowMs: number) => ConcreteCandidate[];
  /** Record a codex run's chargeable tokens into the budget meter (called after every codex run). */
  recordCodexUsage?: (provider: string, tokens: number, nowMs: number) => void;
  /** Mark a candidate reactively UNAVAILABLE after a failover-worthy failure (reactive backstop). */
  markCandidateUnavailable?: (candidate: ConcreteCandidate, nowMs: number) => void;
  /** Resolve a Claude account's on-disk auth (`CLAUDE_CONFIG_DIR`) for a claude candidate. */
  getClaudeAccountConfigDir?: (account: string) => string | null;
  /** Resolve a pinned `--implementer/--reviewer claude` to its best available account (scorer-selected, single, no failover). */
  resolvePinnedClaude?: (nowMs: number) => ConcreteCandidate | null;
  /** Notify on a CROSS-provider failover (claude↔codex) only — account↔account within Claude is routine. */
  notifyCrossProviderFailover?: (taskId: string, from: string, to: string) => void;
  /** Notify when a worker reaches AWAITING_APPROVAL so the Slack layer can post an interactive card (A7). */
  notifyAwaitingApproval?: (id: string) => void;
}

export interface DispatchInput {
  task_type: string;
  prompt: string;
  title?: string;
  implementer?: string;
  reviewer?: string;
  base_ref?: string;
  workspace?: string;
  /** Set by retry(): links the new worker back to the one it re-dispatches (C6). */
  retry_of?: string;
}

const TERMINAL: ReadonlySet<string> = new Set(['MERGED', 'FAILED', 'REJECTED', 'CANCELLED']);
/** C6: only a dead-end worker can be retried (a merged one succeeded; the rest are still in-flight). */
const RETRYABLE: ReadonlySet<string> = new Set(['FAILED', 'REJECTED', 'CANCELLED']);

export class WorkerOrchestrator {
  private readonly d: OrchestratorDeps;
  private readonly activeIds = new Set<string>();
  private pumping = false;

  constructor(deps: OrchestratorDeps) {
    this.d = deps;
  }

  private get config(): WorkersConfig {
    return this.d.config;
  }

  private effectiveAdapter(name: string): WorkerAdapterConfig {
    const adapter = this.config.adapters[name];
    return { ...adapter, env_allowlist: composeEnvAllowlist(this.config.security.env_allowlist, adapter.env_allowlist) };
  }

  private async emit(eventType: Parameters<JournalWriter['append']>[0]['event_type'], taskId: string, details: Record<string, unknown> = {}): Promise<void> {
    await this.d.journal.append({ ts: new Date().toISOString(), event_type: eventType, details: { worker_task_id: taskId, ...details } });
  }

  list(): WorkerState[] {
    return this.d.store.list();
  }

  get(id: string): WorkerState | null {
    return this.d.store.read(id);
  }

  async dispatch(input: DispatchInput): Promise<string> {
    const workspaceRoot = input.workspace ?? this.config.workspace_root ?? this.d.resolveActiveSessionCwd();
    if (!workspaceRoot) {
      throw new Error('worker dispatch: no workspace_root resolved (pass --workspace, set workers.workspace_root, or start a lead session)');
    }
    if (!(await this.d.worktreeOps.isGitRepo(workspaceRoot))) {
      throw new Error(`worker dispatch: workspace_root is not a git repo: ${workspaceRoot}`);
    }

    const routed = resolveRouting(input.task_type, this.config.routing, this.config.adapters);
    const implementer = input.implementer ?? routed.implementer;
    const reviewer = input.reviewer ?? routed.reviewer;

    // Under roles (selectCandidates injected), an explicit override may be 'claude' or any DEFINED
    // adapter and pins a single candidate (no failover); without roles, the legacy enabled-adapter rule
    // applies. An override naming neither 'claude' nor a defined adapter fails fast.
    if (this.d.selectCandidates) {
      const validProvider = (p?: string): boolean => p === undefined || p === 'claude' || this.config.adapters[p] !== undefined;
      if (!validProvider(input.implementer)) {
        throw new Error(`dispatch validation error: --implementer "${input.implementer}" is not 'claude' or a defined adapter`);
      }
      if (!validProvider(input.reviewer)) {
        throw new Error(`dispatch validation error: --reviewer "${input.reviewer}" is not 'claude' or a defined adapter`);
      }
    } else if (!this.config.adapters[implementer]?.enabled) {
      throw new Error(`worker dispatch: implementer "${implementer}" is not an enabled adapter`);
    }

    const baseRef = input.base_ref ?? this.config.base_ref ?? 'HEAD';
    const baseSha = await this.d.worktreeOps.resolveBaseSha({ workspaceRoot, baseRef });

    const id = randomUUID();
    const now = new Date().toISOString();
    const task: WorkerTask = {
      id,
      task_type: input.task_type,
      title: input.title ?? input.prompt.slice(0, 80),
      prompt: input.prompt,
      base_ref: baseRef,
      base_sha: baseSha,
      implementer,
      reviewer,
      pinned_implementer: input.implementer ?? null,
      pinned_reviewer: input.reviewer ?? null,
      workspace_root: workspaceRoot,
      created_at: now,
      updated_at: now,
    };
    this.d.store.create(task);
    // Set retry_of synchronously before any await/pump so it is persisted race-free from creation.
    if (input.retry_of) this.d.store.patch(id, { retry_of: input.retry_of });
    await this.emit('worker.queued', id, { task_type: task.task_type, implementer, reviewer, base_ref: baseRef, base_sha: baseSha });

    this.pump();
    return id;
  }

  /** Start the next QUEUED workers while slots are free. QUEUED/AWAITING_APPROVAL hold no slot. */
  private pump(): void {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.activeIds.size < this.config.max_concurrent) {
        const next = this.d.store
          .list()
          .filter((s) => s.status === 'QUEUED' && !this.activeIds.has(s.task.id))
          .sort((a, b) => a.created_at.localeCompare(b.created_at))[0];
        if (!next) break;
        const id = next.task.id;
        this.activeIds.add(id);
        void this.runPipeline(id).finally(() => {
          this.activeIds.delete(id);
          this.pump();
        });
      }
    } finally {
      this.pumping = false;
    }
  }

  private isCancelled(id: string): boolean {
    return this.d.store.read(id)?.status === 'CANCELLED';
  }

  private async runPipeline(id: string): Promise<void> {
    const initial = this.d.store.read(id);
    if (!initial || initial.status !== 'QUEUED') return; // cancelled before start or already advanced
    const task = initial.task;
    const forbidden = this.config.security.forbidden_path_globs;

    try {
      this.d.store.patch(id, { status: 'RUNNING', progress: 'running implementer' });
      await this.emit('worker.dispatched', id, { task_type: task.task_type, implementer: task.implementer, reviewer: task.reviewer, base_ref: task.base_ref, base_sha: task.base_sha });

      // Baseline the main tree ONCE before the first candidate; the loop audits every candidate
      // (success, timeout, non-zero, 429) against it — a main-tree mutation is terminal, no failover.
      const before = await this.d.worktreeOps.snapshotMainTree({ workspaceRoot: task.workspace_root, worktreeDir: this.config.worktree_dir, forbiddenPathGlobs: forbidden });
      const workerStateDir = this.d.store.dir(id);

      const candidates = this.resolveCandidates('implementer', task);
      if (candidates.length === 0) {
        return void (await this.failExhausted(id, []));
      }

      const outcome = await runCandidateLoop(candidates, this.implementerHooks(id, task, before, workerStateDir));
      if (outcome.kind === 'cancelled') return void (await this.finishCancelled(id));
      if (outcome.kind === 'boundary_violation') {
        this.d.store.patch(id, { worktree_path: outcome.worktree });
        return void (await this.fail(id, 'worker.boundary_violation', { violations: ['main_tree_modified'], candidate: candidateLabel(outcome.candidate) }, 'workspace boundary violation'));
      }
      if (outcome.kind === 'exhausted') {
        return void (await this.failExhausted(id, outcome.tried));
      }

      // A winning candidate produced a clean run (its worktree already passed the per-candidate audit).
      const { worktree, result: run, candidate: winner } = outcome;
      const boundaryOk = true;

      // IMPLEMENTED: capture the diff in memory.
      const { patch, changedFiles } = await this.d.worktreeOps.captureDiff({ worktree, baseSha: task.base_sha });

      // A cancel that raced capture must not be clobbered by the sanitize/persist terminal write.
      if (this.isCancelled(id)) return void (await this.finishCancelled(id));

      // Sanitize BEFORE persisting any artifact (HI-002).
      const sanitized = this.d.worktreeOps.sanitizePatch(changedFiles, patch, forbidden);
      if (!sanitized.ok) {
        // Persist only redacted violation metadata — never the raw patch or raw tails.
        this.d.store.patch(id, {
          status: 'REJECTED',
          output: this.redactedOutput(run, changedFiles, boundaryOk),
          error_summary: 'security_denied',
        });
        // F-4 (opt-in): also redact the task prompt/title so a secret-bearing prompt isn't retained.
        if (this.config.security.redact_denied_prompts) this.d.store.redactDeniedTask(id);
        await this.emit('worker.security_denied', id, { violations: sanitized.violations });
        await this.cleanup(id, this.config.retention.keep_rejected);
        return;
      }

      // Passed sanitize → compute hash and persist artifacts.
      const patchSha = this.d.worktreeOps.patchSha256(patch);
      const patchPath = join(workerStateDir, 'patch.diff');
      writeFileSync(patchPath, patch, { mode: 0o600 });
      const output: WorkerOutput = {
        exit_code: run.code,
        timed_out: run.timedOut,
        stdout_tail: redactTails(tailOutput(run.stdout)),
        stderr_tail: redactTails(tailOutput(run.stderr)),
        patch,
        patch_path: patchPath,
        patch_sha256: patchSha,
        patch_bytes: Buffer.byteLength(patch),
        changed_files: changedFiles,
        boundary_ok: true,
      };
      writeFileSync(join(workerStateDir, 'output.json'), JSON.stringify(output, null, 2), { mode: 0o600 });
      this.d.store.patch(id, { status: 'IMPLEMENTED', output });
      // C8: attribute this worker's cost to its provider + task type. Claude parses a USD cost;
      // codex is token-metered (no USD), so cost_usd is null there — the split still shows provider/task.
      const workerCost = winner.provider === 'claude' ? parseClaudeResult(run.stdout).total_cost_usd : null;
      await this.emit('worker.completed', id, {
        worktree_path: worktree, changed_files: changedFiles, exit_code: run.code, timed_out: run.timedOut,
        provider: winner.provider, task_type: task.task_type, cost_usd: workerCost,
      });

      if (this.isCancelled(id)) return void (await this.finishCancelled(id));

      // VALIDATING (H₂).
      this.d.store.patch(id, { status: 'VALIDATING', progress: 'running validation gates' });
      const validation = await this.d.validateOutput({
        gates: this.config.validation_gates,
        worktree,
        workerHome: join(worktree, '.home'),
        envAllowlist: this.config.security.env_allowlist,
        journal: this.d.journal,
        taskId: id,
        allowNoValidation: this.config.validation.allow_no_validation,
      });
      // Discard a cancellation that raced the gate run — never write the validation result or REJECTED.
      if (this.isCancelled(id)) return void (await this.finishCancelled(id));
      this.d.store.patch(id, { validation });
      if (!validation.passed) {
        this.d.store.patch(id, { status: 'REJECTED', error_summary: 'validation_failed' });
        await this.cleanup(id, this.config.retention.keep_rejected);
        return;
      }

      // REVIEWING — resolve the reviewer candidate (failover: codex unavailable → a Claude account).
      this.d.store.patch(id, { status: 'REVIEWING', progress: 'reviewing patch' });
      const reviewDir = join(workerStateDir, 'review');
      const verdict = await this.runReview(id, task, output, worktree, reviewDir, winner);
      // Discard a cancellation that raced the review — never write the verdict or REJECTED.
      if (this.isCancelled(id)) return void (await this.finishCancelled(id));
      this.d.store.patch(id, { review: verdict });
      if (verdict.verdict !== 'approve') {
        this.d.store.patch(id, { status: 'REJECTED', error_summary: 'review_rejected' });
        await this.cleanup(id, this.config.retention.keep_rejected);
        return;
      }

      // AWAITING_APPROVAL — slot freed by the pump's finally.
      this.d.store.patch(id, { status: 'AWAITING_APPROVAL' });
      await this.emit('worker.awaiting_approval', id, { changed_files: changedFiles });
      this.d.notifyAwaitingApproval?.(id);
    } catch (err) {
      if (this.isCancelled(id)) return void (await this.finishCancelled(id));
      await this.fail(id, 'worker.failed', { reason: 'pipeline_error' }, String(err));
    }
  }

  /**
   * Resolve a role's ordered candidate list. With `selectCandidates` injected (production), an explicit
   * pin collapses to a single candidate; otherwise the selector resolves account-first → cross-LLM.
   * Without it (single-adapter unit tests), the legacy one-candidate path runs — exactly today's behavior.
   */
  private resolveCandidates(role: WorkerRole, task: WorkerTask): ConcreteCandidate[] {
    const pinned = role === 'implementer' ? task.pinned_implementer : task.pinned_reviewer;
    if (this.d.selectCandidates) {
      if (pinned) {
        // A pinned `claude` is "account auto-selected" — resolve its best account (single, no failover).
        // A pinned adapter is run unconditionally (operator pinned it — no availability filtering).
        if (pinned === 'claude') {
          const c = this.d.resolvePinnedClaude?.(Date.now()) ?? null;
          return c ? [c] : [];
        }
        return [{ provider: pinned, model: null, effort: null }];
      }
      return this.d.selectCandidates(role, task, Date.now());
    }
    const name = role === 'implementer' ? task.implementer : (task.reviewer ?? task.implementer);
    return [{ provider: name, model: null, effort: null }];
  }

  /** Build the launch plan for a concrete candidate (claude → claude-adapter; otherwise a worker adapter). */
  private buildCandidatePlan(candidate: ConcreteCandidate, task: WorkerTask, worktree: string, stateDir: string): WorkerLaunchPlan {
    if (candidate.provider === 'claude') {
      const configDir = this.d.getClaudeAccountConfigDir?.(candidate.account ?? '') ?? null;
      if (!configDir) {
        throw new Error(`worker: claude candidate has no CLAUDE_CONFIG_DIR for account "${candidate.account ?? ''}"`);
      }
      return buildClaudeWorkerCommand({
        account: { name: candidate.account ?? '', config_dir: configDir },
        prompt: task.prompt,
        worktreePath: worktree,
        envAllowlist: composeEnvAllowlist(this.config.security.env_allowlist, ['PATH']),
        model: candidate.model ?? null,
      });
    }
    return buildWorkerCommand(this.effectiveAdapter(candidate.provider), task, worktree, stateDir);
  }

  private candidateTimeout(candidate: ConcreteCandidate): number {
    if (candidate.provider === 'claude') return CLAUDE_WORKER_TIMEOUT_SECONDS;
    return this.config.adapters[candidate.provider]?.timeout_seconds ?? CLAUDE_WORKER_TIMEOUT_SECONDS;
  }

  /** Record a json-mode (codex) candidate's chargeable tokens into the budget meter — success or failure. */
  private recordCodexIfApplicable(candidate: ConcreteCandidate, run: WorkerExecResult): void {
    if (candidate.provider === 'claude') return;
    if (this.config.adapters[candidate.provider]?.output_format !== 'json') return;
    const parsed = parseCodexJsonStream(run.stdout);
    if (parsed.usage) this.d.recordCodexUsage?.(candidate.provider, chargeableTokens(parsed.usage), Date.now());
  }

  /** Hooks the candidate loop calls for the implementer: fresh worktree per candidate, run, audit, cleanup, emit. */
  /** C3: persist a failed candidate onto the worker's tried_candidates list (best-effort, never throws the loop). */
  private recordTried(id: string, candidate: ConcreteCandidate, kind: CandidateFailureKind, role: 'implementer' | 'reviewer'): void {
    const entry: TriedCandidate = { provider: candidate.provider, reason: kind, role };
    if (candidate.account) entry.account = candidate.account;
    try {
      this.d.store.appendTriedCandidate(id, entry);
    } catch { /* recording is diagnostic; never abort the failover loop on a store hiccup */ }
  }

  private implementerHooks(id: string, task: WorkerTask, before: MainTreeSnapshot, workerStateDir: string): CandidateLoopHooks {
    const forbidden = this.config.security.forbidden_path_globs;
    return {
      createWorktree: async () => {
        const wt = await this.d.worktreeOps.createWorktree({ workspaceRoot: task.workspace_root, worktreeDir: this.config.worktree_dir, baseSha: task.base_sha, taskId: id });
        this.d.store.patch(id, { worktree_path: wt });
        return wt;
      },
      runCandidate: async (candidate, worktree) => {
        const plan = this.buildCandidatePlan(candidate, task, worktree, workerStateDir);
        const run = await runWorker(plan, { cwd: worktree, timeoutSeconds: this.candidateTimeout(candidate), exec: this.d.runImplementer, liveTailPath: join(workerStateDir, 'live.log') });
        this.recordCodexIfApplicable(candidate, run);
        return run;
      },
      auditBoundary: () => this.d.worktreeOps.auditBoundary({ workspaceRoot: task.workspace_root, worktreeDir: this.config.worktree_dir, before, forbiddenPathGlobs: forbidden }),
      removeWorktree: async (wt) => {
        await this.d.worktreeOps.removeWorktree({ workspaceRoot: task.workspace_root, worktreeDir: this.config.worktree_dir, path: wt });
        this.d.store.patch(id, { worktree_path: null });
      },
      markUnavailable: (candidate) => this.d.markCandidateUnavailable?.(candidate, Date.now()),
      isCancelled: () => this.isCancelled(id),
      onCandidateFailed: (candidate, kind) => {
        this.recordTried(id, candidate, kind, 'implementer');
        return this.emit('worker.candidate_failed', id, { candidate: candidateLabel(candidate), reason: kind });
      },
      onFailover: (from, to) => {
        const crossProvider = from.provider !== to.provider;
        if (crossProvider) this.d.notifyCrossProviderFailover?.(id, candidateLabel(from), candidateLabel(to));
        return this.emit('worker.failover', id, { from: candidateLabel(from), to: candidateLabel(to), cross_provider: crossProvider });
      },
      onCleanupError: (path, error) => this.emit('worker.worktree_cleanup_error', id, { path, error }),
    };
  }

  /** Run one reviewer candidate (claude → built plan; adapter → effectiveAdapter), with provider-level degraded. */
  private runReviewer(cand: ConcreteCandidate, task: WorkerTask, output: WorkerOutput, worktree: string, reviewDir: string, winner: ConcreteCandidate): Promise<ReviewVerdict> {
    const degraded = cand.provider === winner.provider;
    if (cand.provider === 'claude') {
      const configDir = this.d.getClaudeAccountConfigDir?.(cand.account ?? '') ?? null;
      if (!configDir) {
        throw new Error(`worker: claude reviewer has no CLAUDE_CONFIG_DIR for account "${cand.account ?? ''}"`);
      }
      const plan = buildClaudeWorkerCommand({
        account: { name: cand.account ?? '', config_dir: configDir },
        prompt: buildReviewPrompt(task, output.patch),
        worktreePath: reviewDir,
        envAllowlist: composeEnvAllowlist(this.config.security.env_allowlist, ['PATH']),
        model: cand.model ?? null,
      });
      const reviewerOverride: ReviewerPlanOverride = { name: candidateLabel(cand), plan, format: 'claude-json', timeoutSeconds: CLAUDE_WORKER_TIMEOUT_SECONDS };
      return this.d.reviewOutput({ task, output, reviewerOverride, degradedOverride: degraded, review: this.config.review, journal: this.d.journal, reviewDir, worktreePath: worktree });
    }
    const reviewerAdapter = this.effectiveAdapter(cand.provider);
    return this.d.reviewOutput({ task, output, reviewerAdapter, degradedOverride: degraded, review: this.config.review, journal: this.d.journal, reviewDir, worktreePath: worktree });
  }

  /**
   * Run the reviewer through a candidate failover loop (mirrors the implementer): a reviewer whose run
   * fails in a failover-worthy way (429/auth/timeout/unspawnable) is marked unavailable and the next
   * reviewer candidate (e.g. an open Claude account) is tried; a genuine approve/reject ends the loop.
   * Fail-closed: no reviewer candidate at all → reject.
   */
  private async runReview(id: string, task: WorkerTask, output: WorkerOutput, worktree: string, reviewDir: string, winner: ConcreteCandidate): Promise<ReviewVerdict> {
    if (!this.d.selectCandidates) {
      const reviewerAdapter = this.effectiveAdapter(task.reviewer ?? task.implementer);
      return this.d.reviewOutput({ task, output, reviewerAdapter, review: this.config.review, journal: this.d.journal, reviewDir, worktreePath: worktree });
    }
    const candidates = this.resolveCandidates('reviewer', task);
    if (candidates.length === 0) {
      await this.emit('worker.review_failed', id, { reason: 'no_reviewer_candidate', verdict: 'reject' });
      return { reviewer: 'none', verdict: 'reject', degraded: false, findings: [], raw_output_tail: '' };
    }
    let last: ReviewVerdict | null = null;
    for (let i = 0; i < candidates.length; i++) {
      const cand = candidates[i];
      const verdict = await this.runReviewer(cand, task, output, worktree, reviewDir, winner);
      last = verdict;
      if (verdict.run_failure && verdict.run_failure !== 'task_failed') {
        this.d.markCandidateUnavailable?.(cand, Date.now());
        this.recordTried(id, cand, verdict.run_failure, 'reviewer');
        await this.emit('worker.candidate_failed', id, { candidate: candidateLabel(cand), reason: verdict.run_failure, role: 'reviewer' });
        const next = candidates[i + 1];
        if (next) {
          const crossProvider = cand.provider !== next.provider;
          if (crossProvider) this.d.notifyCrossProviderFailover?.(id, candidateLabel(cand), candidateLabel(next));
          await this.emit('worker.failover', id, { from: candidateLabel(cand), to: candidateLabel(next), cross_provider: crossProvider, role: 'reviewer' });
        }
        continue;
      }
      return verdict;
    }
    return last!; // all reviewer candidates hit capacity failures → last fail-closed reject
  }

  private async failExhausted(id: string, tried: readonly ConcreteCandidate[]): Promise<void> {
    this.d.store.patch(id, { status: 'FAILED', error_summary: 'all_candidates_exhausted' });
    await this.emit('worker.all_candidates_exhausted', id, { tried: tried.map(candidateLabel) });
    await this.cleanup(id, this.config.retention.keep_rejected);
  }

  private redactedOutput(run: { code: number | null; timedOut: boolean }, changedFiles: string[], boundaryOk: boolean): WorkerOutput {
    return {
      exit_code: run.code,
      timed_out: run.timedOut,
      stdout_tail: '[withheld: security hit]',
      stderr_tail: '[withheld: security hit]',
      patch: '',
      patch_path: '',
      patch_sha256: '',
      patch_bytes: 0,
      changed_files: changedFiles,
      boundary_ok: boundaryOk,
    };
  }

  private async fail(id: string, event: 'worker.failed' | 'worker.boundary_violation', details: Record<string, unknown>, summary: string): Promise<void> {
    this.d.store.patch(id, { status: 'FAILED', error_summary: summary });
    await this.emit(event, id, details);
    await this.cleanup(id, this.config.retention.keep_rejected);
  }

  private async finishCancelled(id: string): Promise<void> {
    // Late completion of a cancelled worker — discard result, no transition, run cleanup once.
    await this.cleanup(id, this.config.retention.keep_rejected);
  }

  private async cleanup(id: string, keep: boolean): Promise<void> {
    const state = this.d.store.read(id);
    if (state && !keep && state.worktree_path) {
      try {
        await this.d.worktreeOps.removeWorktree({ workspaceRoot: state.task.workspace_root, worktreeDir: this.config.worktree_dir, path: state.worktree_path });
      } catch {
        // best-effort
      }
    }
    try {
      rmSync(join(this.d.store.dir(id), 'review'), { recursive: true, force: true });
    } catch {
      // best-effort
    }
    await this.emit('worker.cleanup', id);
  }

  async approve(id: string, by: string): Promise<{ ok: boolean; reason?: string }> {
    const state = this.d.store.read(id);
    if (!state) return { ok: false, reason: 'not_found' };
    if (state.status !== 'AWAITING_APPROVAL') return { ok: false, reason: 'not_awaiting_approval' };

    // Atomic claim: transition AWAITING_APPROVAL → MERGING synchronously (no await between the guard
    // read and this write) so a concurrent approve observes MERGING and is rejected — preventing a
    // double `git apply`. Persisting MERGING also serves crash recovery (reconcileMerging).
    const claimed = this.d.store.patch(id, {
      status: 'MERGING',
      approval: { decided: true, granted: true, by, at: new Date().toISOString() },
    });
    this.activeIds.add(id);
    await this.emit('worker.approved', id, { by });

    // mergeOutput's precondition expects the pre-merge (AWAITING_APPROVAL) snapshot.
    const preMerge: WorkerState = { ...claimed, status: 'AWAITING_APPROVAL' };
    try {
      const result = await this.d.mergeOutput({ workspaceRoot: state.task.workspace_root, state: preMerge, journal: this.d.journal });
      if (result.merged) {
        this.d.store.patch(id, { status: 'MERGED' });
        await this.cleanup(id, this.config.retention.keep_merged);
        return { ok: true };
      }
      const reset = result.resetApproval
        ? { decided: false, granted: false, by: null, at: null }
        : claimed.approval;
      this.d.store.patch(id, { status: 'AWAITING_APPROVAL', approval: reset });
      return { ok: false, reason: result.reason ?? 'merge_failed' };
    } finally {
      this.activeIds.delete(id);
      this.pump();
    }
  }

  async deny(id: string, by: string): Promise<{ ok: boolean; reason?: string }> {
    const state = this.d.store.read(id);
    if (!state) return { ok: false, reason: 'not_found' };
    if (state.status !== 'AWAITING_APPROVAL') return { ok: false, reason: 'not_awaiting_approval' };
    this.d.store.patch(id, { status: 'REJECTED', approval: { decided: true, granted: false, by, at: new Date().toISOString() }, error_summary: 'denied' });
    await this.emit('worker.denied', id, { by });
    await this.cleanup(id, this.config.retention.keep_rejected);
    return { ok: true };
  }

  /**
   * C6: re-dispatch a NEW worker from a terminal-failed worker's original task, linked via retry_of.
   * Rejects an in-flight worker (nothing to retry yet) and an unknown id.
   */
  async retry(id: string): Promise<{ ok: boolean; reason?: string; id?: string }> {
    const w = this.d.store.read(id);
    if (!w) return { ok: false, reason: 'not_found' };
    if (!RETRYABLE.has(w.status)) return { ok: false, reason: `not_retryable: worker is ${w.status}` };
    const newId = await this.dispatch({
      task_type: w.task.task_type,
      prompt: w.task.prompt,
      title: w.task.title,
      implementer: w.task.pinned_implementer ?? undefined,
      reviewer: w.task.pinned_reviewer ?? undefined,
      base_ref: w.task.base_ref,
      workspace: w.task.workspace_root,
      retry_of: id,
    });
    return { ok: true, id: newId };
  }

  /** C10: revert a merged worker's patch from the working tree (git-safe; refuses on divergence). */
  async undoMerge(id: string): Promise<{ ok: boolean; reason?: string }> {
    const state = this.d.store.read(id);
    if (!state) return { ok: false, reason: 'not_found' };
    const res = await undoWorkerMerge({ workspaceRoot: state.task.workspace_root, state, journal: this.d.journal });
    return res.reverted ? { ok: true } : { ok: false, reason: res.reason ?? 'failed' };
  }

  /** C10: list (and with force, remove) orphaned aisup worktrees under worktree_dir. */
  async cleanupWorktrees(force: boolean): Promise<{ orphans: string[]; removed: string[] }> {
    const workspaceRoot = this.config.workspace_root ?? this.d.resolveActiveSessionCwd() ?? undefined;
    if (!workspaceRoot) return { orphans: [], removed: [] };
    const all = await listWorktrees(workspaceRoot);
    const referenced = new Set(
      this.d.store.list()
        .filter((w) => !TERMINAL.has(w.status))
        .map((w) => w.worktree_path)
        .filter((p): p is string => !!p),
    );
    const orphans = orphanWorktrees(all, referenced, this.config.worktree_dir);
    if (!force) return { orphans, removed: [] };
    const removed: string[] = [];
    for (const path of orphans) {
      try {
        await this.d.worktreeOps.removeWorktree({ workspaceRoot, worktreeDir: this.config.worktree_dir, path });
        removed.push(path);
      } catch { /* best effort — a locked/busy worktree is left for the next sweep */ }
    }
    if (removed.length) {
      await this.d.journal.append({ ts: new Date().toISOString(), event_type: 'worker.worktree_orphans_cleaned', details: { removed } });
    }
    return { orphans, removed };
  }

  async cancel(id: string): Promise<{ ok: boolean; reason?: string }> {
    const state = this.d.store.read(id);
    if (!state) return { ok: false, reason: 'not_found' };
    if (TERMINAL.has(state.status)) return { ok: false, reason: 'terminal' };
    const wasActive = this.activeIds.has(id);
    this.d.store.patch(id, { status: 'CANCELLED', error_summary: 'cancelled' });
    await this.emit('worker.cancelled', id);
    this.activeIds.delete(id); // free the slot immediately (cooperative)
    if (!wasActive) {
      // No live pipeline — clean up now. An in-flight pipeline cleans up on completion.
      await this.cleanup(id, this.config.retention.keep_rejected);
    }
    this.pump();
    return { ok: true };
  }

  /** Daemon startup: reconcile interrupted workers, then pump queued work. */
  async start(): Promise<void> {
    await this.rehydrateWorkers();
    this.pump();
  }

  async rehydrateWorkers(): Promise<void> {
    for (const state of this.d.store.list()) {
      const id = state.task.id;
      if (state.status === 'RUNNING' || state.status === 'VALIDATING' || state.status === 'REVIEWING') {
        this.d.store.patch(id, { status: 'FAILED', error_summary: 'rehydrated: in-flight subprocess lost' });
        await this.emit('worker.rehydrated_failed', id);
      } else if (state.status === 'MERGING') {
        await this.reconcileMerging(state);
      }
      // QUEUED and AWAITING_APPROVAL are preserved and remain actionable.
    }
  }

  private async reconcileMerging(state: WorkerState): Promise<void> {
    const id = state.task.id;
    const workspaceRoot = state.task.workspace_root;
    const patchPath = state.output?.patch_path ?? '';
    if (patchPath && (await this.d.worktreeOps.applyReverseCheck(workspaceRoot, patchPath))) {
      this.d.store.patch(id, { status: 'MERGED' });
      await this.emit('worker.rehydrated_merged', id);
      return;
    }
    const reset = { decided: false, granted: false, by: null, at: null };
    if (patchPath && (await this.d.worktreeOps.applyCheck(workspaceRoot, patchPath))) {
      this.d.store.patch(id, { status: 'AWAITING_APPROVAL', approval: reset });
      await this.emit('worker.merge_failed', id, { reason: 'merge_interrupted_before_apply' });
      return;
    }
    this.d.store.patch(id, { status: 'AWAITING_APPROVAL', approval: reset });
    await this.emit('worker.merge_failed', id, { reason: 'apply_conflict' });
  }
}
