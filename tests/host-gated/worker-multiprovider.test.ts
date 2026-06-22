import { describe, it, expect, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { WorkerOrchestrator } from '../../src/workers/orchestrator.js';
import type { OrchestratorDeps } from '../../src/workers/orchestrator.js';
import { WorkerStore } from '../../src/workers/store.js';
import {
  resolveBaseSha, createWorktree, captureDiff, snapshotMainTree, auditBoundary,
  sanitizePatch, patchSha256, removeWorktree, isGitRepo, applyCheck, applyReverseCheck,
} from '../../src/workers/worktree.js';
import { validateWorkerOutput } from '../../src/workers/validation.js';
import { CONFIG_DEFAULTS } from '../../src/config/defaults.js';
import { loadConfig } from '../../src/config/loader.js';
import { UsageLedger } from '../../src/accounts/usage-ledger.js';
import { AccountRegistry } from '../../src/accounts/registry.js';
import { ClaudeProviderUsage } from '../../src/providers/claude-usage.js';
import { CodexProviderUsage } from '../../src/providers/codex-usage.js';
import { resolveCandidates } from '../../src/providers/selector.js';
import type { WorkerExec, WorkerExecResult } from '../../src/workers/runner.js';
import type { JournalEvent, JournalWriter } from '../../src/journal/types.js';
import type { WorkersConfig, RoleCandidateConfig } from '../../src/config/schema.js';

/**
 * Host-gated end-to-end: account-first → cross-LLM worker failover with a REAL surviving worker run.
 * The first claude candidate is forced (injected 429) to trigger a real failover; the next candidate
 * runs `claude -p` for real and edits a file, reaching AWAITING_APPROVAL. Validation/review are faked
 * (approve) so the test isolates the IMPLEMENTER failover chain. Skipped unless AISUP_TEST_MULTIPROVIDER=1.
 *
 * Requires: a live ~/.aisup/config.yaml with ≥1 enabled account, the `claude` CLI on PATH, and
 * CODEX_HOME / account config dirs configured. Yields PASS or SKIP, never a harness ERROR.
 */

const enabled = process.env.AISUP_TEST_MULTIPROVIDER === '1';

/** execFile-based real executor (mirrors the runner's default), for the surviving candidate. */
const realExec: WorkerExec = (command, args, opts) =>
  new Promise<WorkerExecResult>((resolve) => {
    execFile(command, args, { cwd: opts.cwd, timeout: opts.timeoutMs, env: opts.env, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      const e = err as (Error & { code?: number | string; killed?: boolean }) | null;
      const code = !e ? 0 : typeof e.code === 'number' ? e.code : null;
      resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), timedOut: e?.killed === true });
    });
  });

const claudeRole = (): RoleCandidateConfig => ({ provider: 'claude', model: null, effort: null, budget: null });
const codexRole = (): RoleCandidateConfig => ({ provider: 'codex', model: null, effort: null, budget: null });

describe.skipIf(!enabled)('real multi-provider worker failover (set AISUP_TEST_MULTIPROVIDER=1 to enable)', () => {
  let scratch: string;
  let stateDir: string;

  afterEach(() => {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
    if (stateDir) rmSync(stateDir, { recursive: true, force: true });
  });

  it('a forced 429 on the first claude candidate fails over to the next candidate, which completes for real', async () => {
    scratch = join('/private/tmp', `aisup-mp-test-${randomUUID()}`);
    stateDir = join('/private/tmp', `aisup-mp-state-${randomUUID()}`);
    mkdirSync(scratch, { recursive: true });
    writeFileSync(join(scratch, 'README.md'), '# scratch\n');
    const git = (...a: string[]): Promise<unknown> => realExec('git', a, { cwd: scratch, timeoutMs: 30_000, env: process.env as Record<string, string>, stdin: null });
    await git('init', '-q');
    await git('config', 'user.email', 'test@example.com');
    await git('config', 'user.name', 'aisup test');
    await git('add', '.');
    await git('commit', '-q', '-m', 'init');

    const cfg = await loadConfig();
    const accounts = cfg.accounts.filter((a) => a.enabled);
    if (accounts.length < 1) throw new Error('need ≥1 enabled account in ~/.aisup/config.yaml');

    const ledger = new UsageLedger(join(stateDir, 'ledger.json'), 60_000);
    const registry = new AccountRegistry(cfg);
    const claudeUsage = new ClaudeProviderUsage({
      ledger,
      getAccount: (name) => {
        const a = registry.get(name);
        return a ? { name: a.name, enabled: a.enabled, inCooldown: false, reactivelyUnavailable: false } : null;
      },
    });
    const codexUsage = new CodexProviderUsage({ ledger, budget: null });
    const selectCandidates: OrchestratorDeps['selectCandidates'] = (role) =>
      resolveCandidates(role === 'implementer' ? [claudeRole(), codexRole()] : [claudeRole()], { claudeUsage, codexUsage, accounts: registry.getAll().map((a) => ({ name: a.name, enabled: a.enabled })) }, Date.now());

    let call = 0;
    const injectFirst429: WorkerExec = async (command, args, opts) => {
      call++;
      if (call === 1) return { code: 1, stdout: '', stderr: 'Error 429 too many requests (injected)', timedOut: false };
      return realExec(command, args, opts);
    };

    const workersConfig: WorkersConfig = { ...JSON.parse(JSON.stringify(CONFIG_DEFAULTS.workers)) as WorkersConfig, enabled: true, validation_gates: [], validation: { allow_no_validation: true } };
    const events: JournalEvent[] = [];
    const journal: JournalWriter = { append: async (e) => { events.push(e); } };
    const store = new WorkerStore(stateDir);

    const deps: OrchestratorDeps = {
      store, config: workersConfig, journal,
      worktreeOps: { resolveBaseSha, createWorktree, captureDiff, snapshotMainTree, auditBoundary, sanitizePatch, patchSha256, removeWorktree, isGitRepo, applyCheck, applyReverseCheck },
      runImplementer: injectFirst429,
      validateOutput: validateWorkerOutput,
      reviewOutput: async () => ({ reviewer: 'fake', verdict: 'approve', degraded: false, findings: [], raw_output_tail: '' }),
      mergeOutput: async () => ({ merged: false, reason: null, resetApproval: false }),
      resolveActiveSessionCwd: () => scratch,
      selectCandidates,
      getClaudeAccountConfigDir: (name) => registry.get(name)?.configDir ?? null,
      markCandidateUnavailable: () => {},
    };

    const orch = new WorkerOrchestrator(deps);
    const id = await orch.dispatch({ task_type: 'implement', prompt: 'Append a line "hello from worker" to README.md. Make only that edit.', workspace: scratch });

    const start = Date.now();
    while (Date.now() - start < 240_000) {
      const s = store.read(id)?.status;
      if (s === 'AWAITING_APPROVAL' || s === 'FAILED' || s === 'REJECTED') break;
      await new Promise((r) => setTimeout(r, 250));
    }

    const types = events.map((e) => e.event_type);
    expect(types).toContain('worker.candidate_failed');
    expect(types).toContain('worker.failover');
    expect(store.read(id)!.status).toBe('AWAITING_APPROVAL');
    expect(store.read(id)!.output!.changed_files.length).toBeGreaterThan(0);
  }, 300_000);
});
