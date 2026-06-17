import { execFile } from 'node:child_process';
import { runGates, MAX_BUFFER } from '../gates/engine.js';
import type { GateCommandConfig } from '../config/schema.js';
import type { GateRunner } from '../gates/types.js';
import type { JournalEvent, JournalWriter } from '../journal/types.js';

/** Wrapping writer that injects worker_task_id into every event's details (engine has no hook). */
function tagJournal(journal: JournalWriter, taskId: string): JournalWriter {
  return {
    append: (event: JournalEvent) =>
      journal.append({ ...event, details: { ...event.details, worker_task_id: taskId } }),
  };
}

/**
 * Shell-free gate runner closing over the worker validation env — allowlisted vars + isolated
 * HOME, no ambient process.env spread (HI-005). Signature matches GateRunner exactly; env is
 * supplied via the closure since GateRunner opts carry only cwd/timeoutMs.
 */
function makeWorkerGateRunner(envAllowlist: string[], workerHome: string): GateRunner {
  const env: Record<string, string> = {};
  for (const name of envAllowlist) {
    const v = process.env[name];
    if (v !== undefined) env[name] = v;
  }
  env.HOME = workerHome;
  return (command, args, opts) =>
    new Promise((resolve) => {
      execFile(
        command,
        args,
        { cwd: opts.cwd, timeout: opts.timeoutMs, env, maxBuffer: MAX_BUFFER },
        (err, stdout, stderr) => {
          const e = err as (Error & { code?: number | string; killed?: boolean }) | null;
          const timedOut = e?.killed === true;
          let code: number | null;
          if (!e) code = 0;
          else if (typeof e.code === 'number') code = e.code;
          else code = null;
          resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), timedOut });
        }
      );
    });
}

/**
 * Run worker validation gates against the worktree using the existing gate engine (H₂). Gate cwd
 * is normalized to null so defaultCwd=worktree always wins (HI-001). Fail-closed: with no required
 * gate and allowNoValidation false, runGates is never called and validation fails.
 */
export async function validateWorkerOutput(opts: {
  gates: GateCommandConfig[];
  worktree: string;
  workerHome: string;
  envAllowlist: string[];
  journal: JournalWriter;
  taskId: string;
  allowNoValidation: boolean;
  runner?: GateRunner;
}): Promise<{ passed: boolean; failed_gates: string[] }> {
  const { gates, worktree, workerHome, envAllowlist, journal, taskId, allowNoValidation, runner } = opts;
  const tagged = tagJournal(journal, taskId);

  const hasRequired = gates.some((g) => g.required === true);
  if (!hasRequired && !allowNoValidation) {
    await tagged.append({
      ts: new Date().toISOString(),
      event_type: 'worker.validation_failed',
      details: { reason: 'no_gates_configured', failed_gates: [] },
    });
    return { passed: false, failed_gates: [] };
  }

  const workerGates = gates.map((g) => ({ ...g, cwd: null }));
  const gateRunner = runner ?? makeWorkerGateRunner(envAllowlist, workerHome);
  const result = await runGates(workerGates, { journal: tagged, defaultCwd: worktree, runner: gateRunner });
  const failed_gates = result.results.filter((r) => r.status !== 'passed').map((r) => r.name);

  await tagged.append({
    ts: new Date().toISOString(),
    event_type: result.passed ? 'worker.validated' : 'worker.validation_failed',
    details: { failed_gates },
  });

  return { passed: result.passed, failed_gates };
}
