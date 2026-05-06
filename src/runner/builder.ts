import { accessSync, constants } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { singleQuote } from '../util/shell.js';
import type { RunnerConfig, RunnerCommand } from './types.js';

function buildEnv(config: RunnerConfig, accountConfigDir: string): Record<string, string> {
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

  // Resolve via PATH using `which`
  try {
    const resolved = execFileSync('which', [cmd], { encoding: 'utf8' }).trim();
    if (!resolved) throw new Error('empty');
    return resolved;
  } catch {
    throw new Error(`Runner command not found on PATH: ${cmd}`);
  }
}
