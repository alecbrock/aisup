export type GateStatus = 'passed' | 'failed' | 'timeout';

/** Raw outcome of running one gate command. */
export interface GateExecResult {
  /** Process exit code, or null when killed/unspawnable (timeout, ENOENT). */
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface GateResult {
  name: string;
  status: GateStatus;
  exitCode: number | null;
  stdoutTail: string;
  stderrTail: string;
  required: boolean;
}

export interface GateRunResult {
  /** True when every required gate passed. */
  passed: boolean;
  results: GateResult[];
}

/** Shell-free command runner: an executable plus an argument array. */
export type GateRunner = (
  command: string,
  args: string[],
  opts: { cwd?: string; timeoutMs: number }
) => Promise<GateExecResult>;
