import { randomUUID } from 'node:crypto';
import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { buildWorkerCommand, composeEnvAllowlist, resolveRouting } from './adapter.js';
import { runWorker } from './runner.js';
import type { WorkerExec } from './runner.js';
import type { validateWorkerOutput } from './validation.js';
import type { reviewWorkerOutput } from './review.js';
import type { mergeWorkerOutput } from './merge.js';
import type { MainTreeSnapshot } from './worktree.js';
import { WorkerStore } from './store.js';
import type { WorkersConfig, WorkerAdapterConfig } from '../config/schema.js';
import type { JournalWriter } from '../journal/types.js';
import type { WorkerOutput, WorkerState, WorkerTask } from './types.js';

const SECRET_LINE =
  /(token|secret|api[_-]?key|password|authorization|bot_token|app_token|signing_secret)\s*[:=]/i;

function redactTails(text: string): string {
  return text
    .split('\n')
    .map((l) => (SECRET_LINE.test(l) ? '[redacted]' : l))
    .join('\n');
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
}

export interface DispatchInput {
  task_type: string;
  prompt: string;
  title?: string;
  implementer?: string;
  reviewer?: string;
  base_ref?: string;
  workspace?: string;
}

const TERMINAL: ReadonlySet<string> = new Set(['MERGED', 'FAILED', 'REJECTED', 'CANCELLED']);

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
    if (!this.config.adapters[implementer]?.enabled) {
      throw new Error(`worker dispatch: implementer "${implementer}" is not an enabled adapter`);
    }
    const reviewer = input.reviewer ?? routed.reviewer;

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
      workspace_root: workspaceRoot,
      created_at: now,
      updated_at: now,
    };
    this.d.store.create(task);
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
      this.d.store.patch(id, { status: 'RUNNING' });
      await this.emit('worker.dispatched', id, { task_type: task.task_type, implementer: task.implementer, reviewer: task.reviewer, base_ref: task.base_ref, base_sha: task.base_sha });

      const before = await this.d.worktreeOps.snapshotMainTree({ workspaceRoot: task.workspace_root, worktreeDir: this.config.worktree_dir, forbiddenPathGlobs: forbidden });
      const worktree = await this.d.worktreeOps.createWorktree({ workspaceRoot: task.workspace_root, worktreeDir: this.config.worktree_dir, baseSha: task.base_sha, taskId: id });
      this.d.store.patch(id, { worktree_path: worktree });

      const adapter = this.effectiveAdapter(task.implementer);
      const workerStateDir = this.d.store.dir(id);
      const plan = buildWorkerCommand(adapter, task, worktree, workerStateDir);
      const run = await runWorker(plan, { cwd: worktree, timeoutSeconds: adapter.timeout_seconds, exec: this.d.runImplementer });

      if (this.isCancelled(id)) return void (await this.finishCancelled(id));

      if (run.timedOut) {
        return void (await this.fail(id, 'worker.failed', { reason: 'timed_out' }, 'worker timed out'));
      }
      if (run.code === null) {
        return void (await this.fail(id, 'worker.failed', { reason: 'adapter_unresolved' }, 'worker could not be executed'));
      }

      // IMPLEMENTED: capture the diff in memory.
      const { patch, changedFiles } = await this.d.worktreeOps.captureDiff({ worktree, baseSha: task.base_sha });

      // Boundary audit (fail → FAILED, merge blocked).
      const boundaryOk = await this.d.worktreeOps.auditBoundary({ workspaceRoot: task.workspace_root, worktreeDir: this.config.worktree_dir, before, forbiddenPathGlobs: forbidden });

      // A cancel that raced capture/audit must not be clobbered by the boundary/sanitize terminal write.
      if (this.isCancelled(id)) return void (await this.finishCancelled(id));

      if (!boundaryOk) {
        return void (await this.fail(id, 'worker.boundary_violation', { violations: ['main_tree_modified'] }, 'workspace boundary violation'));
      }

      // Sanitize BEFORE persisting any artifact (HI-002).
      const sanitized = this.d.worktreeOps.sanitizePatch(changedFiles, patch, forbidden);
      if (!sanitized.ok) {
        // Persist only redacted violation metadata — never the raw patch or raw tails.
        this.d.store.patch(id, {
          status: 'REJECTED',
          output: this.redactedOutput(run, changedFiles, boundaryOk),
          error_summary: 'security_denied',
        });
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
        stdout_tail: redactTails(run.stdout),
        stderr_tail: redactTails(run.stderr),
        patch,
        patch_path: patchPath,
        patch_sha256: patchSha,
        patch_bytes: Buffer.byteLength(patch),
        changed_files: changedFiles,
        boundary_ok: true,
      };
      writeFileSync(join(workerStateDir, 'output.json'), JSON.stringify(output, null, 2), { mode: 0o600 });
      this.d.store.patch(id, { status: 'IMPLEMENTED', output });
      await this.emit('worker.completed', id, { worktree_path: worktree, changed_files: changedFiles, exit_code: run.code, timed_out: run.timedOut });

      if (this.isCancelled(id)) return void (await this.finishCancelled(id));

      // VALIDATING (H₂).
      this.d.store.patch(id, { status: 'VALIDATING' });
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

      // REVIEWING.
      this.d.store.patch(id, { status: 'REVIEWING' });
      const reviewDir = join(workerStateDir, 'review');
      const reviewerAdapter = this.effectiveAdapter(task.reviewer ?? task.implementer);
      const verdict = await this.d.reviewOutput({
        task,
        output,
        reviewerAdapter,
        review: this.config.review,
        journal: this.d.journal,
        reviewDir,
        worktreePath: worktree,
      });
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
    } catch (err) {
      if (this.isCancelled(id)) return void (await this.finishCancelled(id));
      await this.fail(id, 'worker.failed', { reason: 'pipeline_error' }, String(err));
    }
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
