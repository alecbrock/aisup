import { describe, it, expect, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { WorkerOrchestrator } from '../../src/workers/orchestrator.js';
import type { OrchestratorDeps } from '../../src/workers/orchestrator.js';
import { WorkerStore } from '../../src/workers/store.js';
import {
  resolveBaseSha, createWorktree, captureDiff, snapshotMainTree, auditBoundary,
  sanitizePatch, patchSha256, removeWorktree, isGitRepo, applyCheck, applyReverseCheck,
} from '../../src/workers/worktree.js';
import { validateWorkerOutput } from '../../src/workers/validation.js';
import { reviewWorkerOutput } from '../../src/workers/review.js';
import { mergeWorkerOutput } from '../../src/workers/merge.js';
import { CONFIG_DEFAULTS } from '../../src/config/defaults.js';
import { loadConfig } from '../../src/config/loader.js';
import { UsageLedger } from '../../src/accounts/usage-ledger.js';
import { AccountRegistry } from '../../src/accounts/registry.js';
import { CodexProviderUsage } from '../../src/providers/codex-usage.js';
import { ClaudeProviderUsage } from '../../src/providers/claude-usage.js';
import { resolveCandidates } from '../../src/providers/selector.js';
import type { WorkerExec, WorkerExecResult } from '../../src/workers/runner.js';
import type { JournalEvent, JournalWriter } from '../../src/journal/types.js';
import type { WorkersConfig, RoleCandidateConfig } from '../../src/config/schema.js';
import type { ConcreteCandidate } from '../../src/providers/types.js';
import type { AccountConfig } from '../../src/config/schema.js';
import type { WorktreeOps } from '../../src/workers/orchestrator.js';

/**
 * Host-gated REAL multi-provider failover matrix (Part B Truths 1/2). Each reachable leg drives the
 * REAL orchestrator + REAL worktree ops + REAL runWorker + the REAL review.ts (no faked reviewOutput).
 * The FAILING candidate is forced cheaply (injected 429 at the exec layer); the WINNING candidate runs
 * a real `claude -p` / `codex exec --json` that edits a file. codex→claude legs are excluded
 * (unreachable under the account-first selector). Skipped unless AISUP_TEST_MULTIPROVIDER=1; PASS or
 * SKIP, never a harness ERROR.
 *
 * Requires: live ~/.aisup/config.yaml with enabled accounts, `claude` + `codex` on PATH, and codex
 * ChatGPT auth in ~/.codex (reached via CODEX_HOME while the worker HOME is isolated).
 *
 * ⛔ KNOWN BLOCKER (2026-06-23): the REAL `claude -p` worker primitive does not edit files in this
 * environment — the operator's ~/.claude config registers Pilot `UserPromptSubmit`/`SessionEnd` hooks
 * that reference `$HOME/.pilot/...`, and the worker isolates HOME to the worktree `.home` (no `.pilot`
 * there) → the hook fails → claude blocks the prompt (num_turns:0) and never edits. The operator's own
 * `tests/host-gated/claude-worker.test.ts` fails identically, so it is PRE-EXISTING, not caused by this
 * matrix. The codex primitive is unaffected (T3 passes). Consequently the claude-dependent legs below
 * (account-first impl, claude reviewers) cannot complete until the claude-worker × Pilot-hooks ×
 * HOME-isolation conflict is resolved (operator decision — see plan Task 4 blocker note). The
 * deterministic budget-gate leg (no real run) passes today.
 */

const enabled = process.env.AISUP_TEST_MULTIPROVIDER === '1';

const WORKTREE_OPS: WorktreeOps = {
  resolveBaseSha, createWorktree, captureDiff, snapshotMainTree, auditBoundary,
  sanitizePatch, patchSha256, removeWorktree, isGitRepo, applyCheck, applyReverseCheck,
};

/** execFile-based real executor (mirrors the runner's default) for the surviving candidate. */
const realExec: WorkerExec = (command, args, opts) =>
  new Promise<WorkerExecResult>((resolve) => {
    const child = execFile(
      command, args,
      { cwd: opts.cwd, timeout: opts.timeoutMs, env: opts.env, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const e = err as (Error & { code?: number | string; killed?: boolean }) | null;
        const code = !e ? 0 : typeof e.code === 'number' ? e.code : null;
        resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), timedOut: e?.killed === true });
      }
    );
    // ⛔ Close stdin: `codex exec` appends piped stdin as a <stdin> block and blocks if it stays open.
    if (opts.stdin !== null && child.stdin) child.stdin.write(opts.stdin);
    child.stdin?.end();
  });

const INJECTED_429: WorkerExecResult = { code: 1, stdout: '', stderr: 'Error 429 too many requests (injected)', timedOut: false };

/** Retry rm — real claude/codex spawn lingering uv/npm/MCP processes that write to the isolated
 * .home after the run returns, so a single rmSync can race to ENOTEMPTY. */
function safeRm(path: string): void {
  for (let i = 0; i < 5; i++) {
    try { rmSync(path, { recursive: true, force: true }); return; } catch { /* retry */ }
  }
}

/** An implementer exec that fails the first `failCalls` invocations (429) then runs for real. */
function failingImplExec(failCalls: number): WorkerExec {
  let n = 0;
  return async (command, args, opts) => {
    n++;
    if (n <= failCalls) return INJECTED_429;
    return realExec(command, args, opts);
  };
}

/** A reviewOutput that forces the first `failReviewerCalls` reviewer candidates to 429, then runs the
 * REAL review.ts (default real runner). The injection is at the RUNNER layer — review.ts still does the
 * real classification/failover, so no verdict is faked. */
function failingReviewOutput(failReviewerCalls: number): typeof reviewWorkerOutput {
  let n = 0;
  return (opts) => {
    n++;
    if (n <= failReviewerCalls) {
      const inject: WorkerExec = async () => INJECTED_429;
      return reviewWorkerOutput({ ...opts, runner: inject });
    }
    return reviewWorkerOutput(opts); // real reviewer subprocess (default runner)
  };
}

const claudeCand = (account: string): ConcreteCandidate => ({ provider: 'claude', account, model: null, effort: null });
const codexCand = (): ConcreteCandidate => ({ provider: 'codex', model: null, effort: null });
const claudeRole = (): RoleCandidateConfig => ({ provider: 'claude', model: null, effort: null, budget: null });
const codexRole = (): RoleCandidateConfig => ({ provider: 'codex', model: null, effort: null, budget: null });

function workersConfig(allowSameModelReview = false): WorkersConfig {
  const w = JSON.parse(JSON.stringify(CONFIG_DEFAULTS.workers)) as WorkersConfig;
  // codex auth (ChatGPT login in ~/.codex) is reached via CODEX_HOME while HOME is isolated to the
  // worktree — so the codex worker adapter must allowlist CODEX_HOME (the test sets process.env.CODEX_HOME).
  if (w.adapters.codex) {
    w.adapters.codex.env_allowlist = ['PATH', 'HOME', 'CODEX_HOME'];
  }
  return {
    ...w,
    enabled: true,
    validation_gates: [],
    validation: { allow_no_validation: true },
    review: { allow_same_model_review: allowSameModelReview },
  };
}

interface Harness {
  scratch: string;
  stateDir: string;
  store: WorkerStore;
  events: JournalEvent[];
  registry: AccountRegistry;
  ledger: UsageLedger;
  accounts: AccountConfig[];
}

async function setupRepo(): Promise<Harness> {
  const scratch = join('/private/tmp', `aisup-mp-${randomUUID()}`);
  const stateDir = join('/private/tmp', `aisup-mp-state-${randomUUID()}`);
  mkdirSync(scratch, { recursive: true });
  writeFileSync(join(scratch, 'README.md'), '# scratch\n');
  const git = (...a: string[]): Promise<unknown> =>
    realExec('git', a, { cwd: scratch, timeoutMs: 30_000, env: process.env as Record<string, string>, stdin: null });
  await git('init', '-q');
  await git('config', 'user.email', 'test@example.com');
  await git('config', 'user.name', 'aisup test');
  await git('add', '.');
  await git('commit', '-q', '-m', 'init');

  const cfg = await loadConfig();
  const accounts = cfg.accounts.filter((a) => a.enabled);
  const ledger = new UsageLedger(join(stateDir, 'ledger.json'), 60_000);
  const registry = new AccountRegistry(cfg);
  const events: JournalEvent[] = [];
  const store = new WorkerStore(stateDir);
  return { scratch, stateDir, store, events, registry, ledger, accounts };
}

function baseDeps(h: Harness, config: WorkersConfig): Omit<OrchestratorDeps, 'runImplementer' | 'reviewOutput' | 'selectCandidates'> {
  const journal: JournalWriter = { append: async (e) => { h.events.push(e); } };
  return {
    store: h.store, config, journal,
    worktreeOps: WORKTREE_OPS,
    validateOutput: validateWorkerOutput,
    mergeOutput: mergeWorkerOutput,
    resolveActiveSessionCwd: () => h.scratch,
    getClaudeAccountConfigDir: (name) => h.registry.get(name)?.configDir ?? null,
    markCandidateUnavailable: () => {},
    recordCodexUsage: () => {},
    notifyCrossProviderFailover: () => {},
  };
}

async function waitTerminal(store: WorkerStore, id: string, timeoutMs: number): Promise<string> {
  const start = Date.now();
  for (;;) {
    const s = store.read(id)?.status;
    if (s === 'AWAITING_APPROVAL' || s === 'FAILED' || s === 'REJECTED' || s === 'CANCELLED') return s;
    if (Date.now() - start > timeoutMs) return store.read(id)?.status ?? 'UNKNOWN';
    await new Promise((r) => setTimeout(r, 250));
  }
}

const PROMPT = 'Append a single new line that says "hello from worker" to README.md. Make only that one edit.';

describe.skipIf(!enabled)('real multi-provider worker failover matrix (set AISUP_TEST_MULTIPROVIDER=1)', () => {
  let h: Harness | null = null;
  afterEach(() => {
    if (h) {
      safeRm(h.scratch);
      safeRm(h.stateDir);
    }
    h = null;
  });

  // Leg A — implementer account-first (Truth 1): first claude account forced-fail → next REAL claude
  // account wins → AWAITING_APPROVAL through the REAL reviewer; journal candidate_failed→failover→completed.
  it('account-first: a forced claude 429 fails over to a real claude account that completes + real review', async () => {
    h = await setupRepo();
    if (h.accounts.length < 2) { expect(h.accounts.length).toBeLessThan(2); return; } // need ≥2 accounts; skip-equivalent
    process.env.CODEX_HOME = join(homedir(), '.codex');
    const config = workersConfig(true); // claude impl + claude reviewer is same-provider → allow it to run
    const impl = [claudeCand(h.accounts[0].name), claudeCand(h.accounts[1].name)];
    const reviewer = [claudeCand(h.accounts[1].name)];
    const orch = new WorkerOrchestrator({
      ...baseDeps(h, config),
      runImplementer: failingImplExec(1),
      reviewOutput: failingReviewOutput(0),
      selectCandidates: (role) => (role === 'implementer' ? impl : reviewer),
    });
    const id = await orch.dispatch({ task_type: 'implement', prompt: PROMPT, workspace: h.scratch });
    const status = await waitTerminal(h.store, id, 280_000);

    const types = h.events.map((e) => e.event_type);
    expect(types).toContain('worker.candidate_failed');
    expect(types).toContain('worker.failover');
    expect(types).toContain('worker.completed');
    // Truth 1: the same task completed on the next REAL claude account (account-first failover) and
    // edited the scratch file. The REAL reviewer then returns a verdict — approve→AWAITING_APPROVAL or
    // reject→REJECTED; both prove review.ts ran for real (no faked reviewer). The verdict itself is
    // non-deterministic real-model behavior, so it is not asserted.
    expect(['AWAITING_APPROVAL', 'REJECTED']).toContain(status);
    expect(h.store.read(id)!.output!.changed_files).toContain('README.md');
  }, 300_000);

  // Leg B — implementer cross-LLM (Truth 2a): all claude forced-fail → REAL codex wins → AWAITING_APPROVAL;
  // worker.failover {cross_provider:true}.
  it('cross-LLM: all claude forced-fail fails over to a real codex worker (cross_provider:true)', async () => {
    h = await setupRepo();
    if (h.accounts.length < 2) { expect(h.accounts.length).toBeLessThan(2); return; }
    process.env.CODEX_HOME = join(homedir(), '.codex');
    const config = workersConfig(false);
    const impl = [claudeCand(h.accounts[0].name), codexCand()];
    // Reviewer is a real claude account reviewing a codex change → cross-model (not degraded), runs for real.
    const reviewer = [claudeCand(h.accounts[1].name)];
    const orch = new WorkerOrchestrator({
      ...baseDeps(h, config),
      runImplementer: failingImplExec(1), // the single claude candidate fails → codex wins
      reviewOutput: failingReviewOutput(0),
      selectCandidates: (role) => (role === 'implementer' ? impl : reviewer),
    });
    const id = await orch.dispatch({ task_type: 'implement', prompt: PROMPT, workspace: h.scratch });
    const status = await waitTerminal(h.store, id, 280_000);

    // Truth 2a: claude→codex cross-LLM failover with a REAL codex worker that edits the file.
    const failover = h.events.find((e) => e.event_type === 'worker.failover' && (e.details as { cross_provider?: boolean }).cross_provider === true);
    expect(failover).toBeDefined();
    expect(h.store.read(id)!.output!.changed_files).toContain('README.md');
    expect(['AWAITING_APPROVAL', 'REJECTED']).toContain(status); // real reviewer verdict (either proves review.ts ran)
  }, 300_000);

  // Leg C — budget gates codex (Truth 2b): codex budget crossed → codex excluded by the selector; all
  // claude forced-fail → worker.all_candidates_exhausted with NO codex subprocess run. Deterministic, no spend.
  it('budget gate: a crossed codex budget + all-claude-down terminates all_candidates_exhausted (no codex run)', async () => {
    h = await setupRepo();
    if (h.accounts.length < 1) { expect(h.accounts.length).toBe(0); return; }
    const config = workersConfig(false);
    const budget = { tokens: 1, period_hours: 5 };
    // Seed codex consumption ABOVE the tiny cap so the selector marks codex budget_exhausted.
    h.ledger.recordConsumption('codex', 1_000, Date.now(), budget);
    const claudeUsage = new ClaudeProviderUsage({
      ledger: h.ledger,
      getAccount: (name) => {
        const a = h!.registry.get(name);
        return a ? { name: a.name, enabled: a.enabled, inCooldown: false, reactivelyUnavailable: false } : null;
      },
    });
    const codexUsage = new CodexProviderUsage({ ledger: h.ledger, budget });
    let codexRuns = 0;
    const countingExec: WorkerExec = async (command, args, opts) => {
      if (command.includes('codex')) codexRuns++;
      return INJECTED_429; // every claude candidate fails; codex should never be reached
    };
    const orch = new WorkerOrchestrator({
      ...baseDeps(h, config),
      runImplementer: countingExec,
      reviewOutput: failingReviewOutput(0),
      selectCandidates: (role) =>
        resolveCandidates(
          role === 'implementer' ? [claudeRole(), codexRole()] : [claudeRole()],
          { claudeUsage, codexUsage, accounts: h!.registry.getAll().map((a) => ({ name: a.name, enabled: a.enabled })) },
          Date.now(),
        ),
    });
    const id = await orch.dispatch({ task_type: 'implement', prompt: PROMPT, workspace: h.scratch });
    const status = await waitTerminal(h.store, id, 60_000);

    const types = h.events.map((e) => e.event_type);
    expect(types).toContain('worker.all_candidates_exhausted');
    expect(status).toBe('FAILED');
    expect(codexRuns).toBe(0); // codex was budget-gated out — never spawned
  }, 90_000);

  // Leg D — reviewer cross-LLM: a real claude implementer winner, then the first claude reviewer is
  // forced-fail → reviewer fails over to a REAL codex reviewer (cross_provider) that yields a verdict
  // through the real review.ts.
  it('reviewer cross-LLM: a forced claude reviewer 429 fails over to a real codex reviewer verdict', async () => {
    h = await setupRepo();
    if (h.accounts.length < 2) { expect(h.accounts.length).toBeLessThan(2); return; }
    process.env.CODEX_HOME = join(homedir(), '.codex');
    // allowSameModelReview:true so the first (claude, same-provider-as-impl → degraded) reviewer
    // actually RUNS and hits the injected 429 → fails over to the codex reviewer (rather than
    // short-circuiting to a degraded reject before the failover can fire).
    const config = workersConfig(true);
    const impl = [claudeCand(h.accounts[1].name)]; // real claude implementer (account[1], authed)
    const reviewer = [claudeCand(h.accounts[1].name), codexCand()];
    const orch = new WorkerOrchestrator({
      ...baseDeps(h, config),
      runImplementer: failingImplExec(0), // implementer runs real on the first try
      reviewOutput: failingReviewOutput(1), // first reviewer candidate (claude) forced-fail → codex reviewer
      selectCandidates: (role) => (role === 'implementer' ? impl : reviewer),
    });
    const id = await orch.dispatch({ task_type: 'implement', prompt: PROMPT, workspace: h.scratch });
    const status = await waitTerminal(h.store, id, 280_000);

    const reviewerFailover = h.events.find(
      (e) => e.event_type === 'worker.failover' && (e.details as { role?: string }).role === 'reviewer'
    );
    expect(reviewerFailover).toBeDefined();
    expect((reviewerFailover!.details as { cross_provider?: boolean }).cross_provider).toBe(true);
    // A real codex reviewer ran and the worker reached a verdict-bearing terminal (approve→AWAITING_APPROVAL
    // or reject→REJECTED); both prove the real review.ts produced a real verdict.
    expect(['AWAITING_APPROVAL', 'REJECTED']).toContain(status);
  }, 300_000);

  // Leg E — reviewer account-first: a real claude implementer winner, then the first claude reviewer is
  // forced-fail → reviewer fails over to a REAL second claude account (account-first, cross_provider:false)
  // that yields a verdict through the real review.ts.
  it('reviewer account-first: a forced claude reviewer 429 fails over to a real claude reviewer verdict', async () => {
    h = await setupRepo();
    if (h.accounts.length < 3) { expect(h.accounts.length).toBeLessThan(3); return; }
    process.env.CODEX_HOME = join(homedir(), '.codex');
    const config = workersConfig(true); // claude reviewer of a claude change → same-provider → must be allowed
    const impl = [claudeCand(h.accounts[1].name)]; // real claude implementer (account[1], authed)
    const reviewer = [claudeCand(h.accounts[1].name), claudeCand(h.accounts[2].name)]; // forced-fail → real account[2]
    const orch = new WorkerOrchestrator({
      ...baseDeps(h, config),
      runImplementer: failingImplExec(0),
      reviewOutput: failingReviewOutput(1), // first claude reviewer forced-fail → second claude account
      selectCandidates: (role) => (role === 'implementer' ? impl : reviewer),
    });
    const id = await orch.dispatch({ task_type: 'implement', prompt: PROMPT, workspace: h.scratch });
    const status = await waitTerminal(h.store, id, 280_000);

    const reviewerFailover = h.events.find(
      (e) => e.event_type === 'worker.failover' && (e.details as { role?: string }).role === 'reviewer'
    );
    expect(reviewerFailover).toBeDefined();
    expect((reviewerFailover!.details as { cross_provider?: boolean }).cross_provider).toBe(false);
    expect(['AWAITING_APPROVAL', 'REJECTED']).toContain(status);
  }, 300_000);
});
