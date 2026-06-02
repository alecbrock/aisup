import { execFile } from 'node:child_process';
import type { GateCommandConfig } from '../config/schema.js';
import type { JournalWriter } from '../journal/types.js';
import type { GateExecResult, GateResult, GateRunResult, GateRunner, GateStatus } from './types.js';

/** Max chars of stdout/stderr retained per gate (the tail is kept). */
export const GATE_OUTPUT_TAIL_LIMIT = 2000;

/** Cap on captured subprocess output to bound memory before truncation. */
const MAX_BUFFER = 10 * 1024 * 1024;

/** Default runner: shell-free `execFile(command, args)` — never a shell string. */
const defaultGateRunner: GateRunner = (command, args, opts) =>
  new Promise((resolve) => {
    execFile(
      command,
      args,
      { cwd: opts.cwd, timeout: opts.timeoutMs, maxBuffer: MAX_BUFFER },
      (err, stdout, stderr) => {
        const e = err as (Error & { code?: number | string; killed?: boolean }) | null;
        const timedOut = e?.killed === true;
        let code: number | null;
        if (!e) code = 0;
        else if (typeof e.code === 'number') code = e.code;
        else code = null; // ENOENT, signal-kill, etc.
        resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), timedOut });
      }
    );
  });

function tail(text: string, limit: number): string {
  return text.length <= limit ? text : text.slice(text.length - limit);
}

function classify(exec: GateExecResult): GateStatus {
  if (exec.timedOut) return 'timeout';
  return exec.code === 0 ? 'passed' : 'failed';
}

export interface GateEngineDeps {
  journal: JournalWriter;
  /** Override the subprocess runner (defaults to shell-free execFile). */
  runner?: GateRunner;
  /** Working directory for gates whose own `cwd` is null. */
  defaultCwd?: string;
}

/**
 * Run validation gates sequentially using shell-free executable/argument arrays. Every gate
 * runs (no short-circuit) so the report is complete; the run `passed` only when all required
 * gates passed. Emits `gate.started`, a terminal per-gate event, and `gate.run_completed`.
 */
export async function runGates(gates: GateCommandConfig[], deps: GateEngineDeps): Promise<GateRunResult> {
  const runner = deps.runner ?? defaultGateRunner;
  const results: GateResult[] = [];
  let passed = true;

  for (const gate of gates) {
    await deps.journal.append({
      ts: new Date().toISOString(),
      event_type: 'gate.started',
      details: { name: gate.name, command: gate.command, args: gate.args },
    });

    const exec = await runner(gate.command, gate.args, {
      cwd: gate.cwd ?? deps.defaultCwd,
      timeoutMs: gate.timeout_seconds * 1000,
    });
    const status = classify(exec);
    const result: GateResult = {
      name: gate.name,
      status,
      exitCode: exec.code,
      stdoutTail: tail(exec.stdout, GATE_OUTPUT_TAIL_LIMIT),
      stderrTail: tail(exec.stderr, GATE_OUTPUT_TAIL_LIMIT),
      required: gate.required,
    };
    results.push(result);

    const event = status === 'passed' ? 'gate.passed' : status === 'timeout' ? 'gate.timeout' : 'gate.failed';
    await deps.journal.append({
      ts: new Date().toISOString(),
      event_type: event,
      details: {
        name: gate.name,
        exit_code: exec.code,
        required: gate.required,
        stdout_tail: result.stdoutTail,
        stderr_tail: result.stderrTail,
      },
    });

    if (status !== 'passed' && gate.required) passed = false;
  }

  await deps.journal.append({
    ts: new Date().toISOString(),
    event_type: 'gate.run_completed',
    details: {
      passed,
      total: results.length,
      failed: results.filter((r) => r.status !== 'passed').map((r) => r.name),
    },
  });

  return { passed, results };
}
