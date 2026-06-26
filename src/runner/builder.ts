import { accessSync, constants } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { singleQuote } from '../util/shell.js';
import type { RunnerConfig, RunnerCommand } from './types.js';

const ENV_VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function buildEnv(config: RunnerConfig, accountConfigDir: string): Record<string, string> {
  // config_dir_env becomes a bare tmux `-e NAME=value` key — a hyphen/space/empty name corrupts the
  // assignment silently (AF-318).
  if (!ENV_VAR_NAME.test(config.config_dir_env)) {
    throw new Error(
      `Runner config error: config_dir_env "${config.config_dir_env}" is not a valid POSIX env var name`
    );
  }
  // accountConfigDir resolves real Claude auth; a null/empty/control-byte value yields the literal
  // "null" path or a corrupt -e value and a cryptic auth failure (AF-317).
  if (!accountConfigDir || /[\x00-\x1f]/.test(accountConfigDir)) {
    throw new Error(
      `Runner config error: accountConfigDir must be a non-empty path with no control characters (got ${JSON.stringify(accountConfigDir)})`
    );
  }
  return { [config.config_dir_env]: accountConfigDir };
}

function buildArgs(config: RunnerConfig, extra: string[] = []): string[] {
  const args = [...config.args, ...extra];
  if (config.remote_control_prefix) {
    args.push('--remote-control-session-name-prefix', config.remote_control_prefix);
  }
  return args;
}

function buildExecString(command: string, args: string[]): string {
  return 'exec ' + [command, ...args].map(singleQuote).join(' ');
}

export function buildLaunchCommand(config: RunnerConfig, accountConfigDir: string): RunnerCommand {
  const args = buildArgs(config);
  return {
    command: config.command,
    args,
    env: buildEnv(config, accountConfigDir),
    execString: buildExecString(config.command, args),
  };
}

export function buildResumeCommand(
  config: RunnerConfig,
  accountConfigDir: string,
  claudeSessionId: string | null
): RunnerCommand {
  if (claudeSessionId === null) {
    throw new Error(
      'buildResumeCommand: claudeSessionId must not be null — use buildLaunchCommand for fresh starts'
    );
  }
  const args = buildArgs(config, [config.resume_flag, claudeSessionId]);
  return {
    command: config.command,
    args,
    env: buildEnv(config, accountConfigDir),
    execString: buildExecString(config.command, args),
  };
}

/** Resolves runner.command to an absolute path. Throws if not found or not executable. */
export function validateRunner(config: RunnerConfig): string {
  const cmd = config.command;

  // Already absolute
  if (cmd.startsWith('/')) {
    try {
      accessSync(cmd, constants.X_OK);
      return cmd;
    } catch {
      throw new Error(`Runner command not found or not executable: ${cmd}`);
    }
  }

  // Resolve via PATH using `which`, then distinguish "not on PATH" from "found but not executable"
  // so setup diagnostics aren't misleading (AF-319).
  let resolved: string;
  try {
    resolved = execFileSync('which', [cmd], { encoding: 'utf8' }).trim();
  } catch {
    throw new Error(`Runner command not found on PATH: ${cmd}`);
  }
  if (!resolved) {
    throw new Error(`Runner command not found on PATH: ${cmd}`);
  }
  try {
    accessSync(resolved, constants.X_OK);
  } catch {
    throw new Error(`Runner command found on PATH but not executable (check permissions): ${resolved}`);
  }
  return resolved;
}
