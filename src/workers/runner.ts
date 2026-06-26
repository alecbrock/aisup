import { execFile } from 'node:child_process';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { GATE_OUTPUT_TAIL_LIMIT, MAX_BUFFER } from '../gates/engine.js';
import type { WorkerLaunchPlan } from './adapter.js';

export interface WorkerExecResult {
  code: number | null; // null on timeout/unspawnable
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Shell-free subprocess executor — injectable so tests assert invocation without spawning real CLIs. */
export type WorkerExec = (
  command: string,
  args: string[],
  opts: { cwd: string; timeoutMs: number; env: Record<string, string>; stdin: string | null }
) => Promise<WorkerExecResult>;

export interface RunWorkerOpts {
  cwd: string;
  timeoutSeconds: number;
  exec?: WorkerExec;
}

function tail(text: string, limit: number): string {
  return text.length <= limit ? text : text.slice(text.length - limit);
}

/**
 * Worker stdout/stderr are returned in FULL by runWorker so the orchestrator/reviewer can PARSE them:
 * claude `--output-format json` and codex `--json` emit a single JSON value, so tail-truncating before
 * the parse corrupts the JSON → empty verdict/usage (the reviewer `parse_failed` root cause). Callers
 * that PERSIST a bounded sample (output.json stdout_tail, review raw_output_tail) truncate to this limit.
 */
export const WORKER_OUTPUT_TAIL_LIMIT = GATE_OUTPUT_TAIL_LIMIT;
export function tailOutput(text: string): string {
  return tail(text, WORKER_OUTPUT_TAIL_LIMIT);
}

/** Default executor: shell-free `execFile(command, args)` mirroring defaultGateRunner; writes stdin then closes it. */
const defaultWorkerExec: WorkerExec = (command, args, opts) =>
  new Promise((resolve) => {
    const child = execFile(
      command,
      args,
      { cwd: opts.cwd, timeout: opts.timeoutMs, env: opts.env, maxBuffer: MAX_BUFFER },
      (err, stdout, stderr) => {
        const e = err as (Error & { code?: number | string; killed?: boolean }) | null;
        const timedOut = e?.killed === true;
        let code: number | null;
        if (!e) code = 0;
        else if (typeof e.code === 'number') code = e.code;
        else code = null; // ENOENT, signal-kill, timeout
        resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), timedOut });
      }
    );
    if (child.stdin) {
      child.stdin.on('error', () => {}); // swallow EPIPE if the child closes stdin early
      if (opts.stdin !== null) child.stdin.write(opts.stdin);
      child.stdin.end();
    }
  });

/**
 * Execute a built launch plan as a shell-free, timed subprocess in the worktree, capturing FULL
 * stdout/stderr (callers parse them; persisted samples are tail-truncated at the persistence site).
 * For prompt_via='file', writes promptFile.contents to its path
 * (under the worker state dir, outside the worktree) before the run and deletes it after —
 * regardless of success/timeout (MD-008/MD-003). Never passes a shell.
 */
export async function runWorker(plan: WorkerLaunchPlan, opts: RunWorkerOpts): Promise<WorkerExecResult> {
  const exec = opts.exec ?? defaultWorkerExec;

  if (plan.promptFile) {
    await mkdir(dirname(plan.promptFile.path), { recursive: true, mode: 0o700 });
    await writeFile(plan.promptFile.path, plan.promptFile.contents, { mode: 0o600 });
  }

  try {
    const res = await exec(plan.command, plan.args, {
      cwd: opts.cwd,
      timeoutMs: opts.timeoutSeconds * 1000,
      env: plan.env,
      stdin: plan.stdin,
    });
    return {
      code: res.code,
      timedOut: res.timedOut,
      // FULL output — the orchestrator/reviewer JSON-parse this; truncation happens at persistence.
      stdout: res.stdout,
      stderr: res.stderr,
    };
  } finally {
    if (plan.promptFile) {
      await rm(plan.promptFile.path, { force: true });
    }
  }
}
