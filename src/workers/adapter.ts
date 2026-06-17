import { join } from 'node:path';
import type { WorkerAdapterConfig, WorkerRoutingConfig } from '../config/schema.js';
import type { WorkerTask } from './types.js';

export interface WorkerLaunchPlan {
  command: string;
  args: string[];
  env: Record<string, string>;
  stdin: string | null;
  promptFile: { path: string; contents: string } | null;
}

/** Union of the global security allowlist and a per-adapter allowlist (dedup, order-stable). */
export function composeEnvAllowlist(securityAllowlist: string[], adapterAllowlist: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of [...securityAllowlist, ...adapterAllowlist]) {
    if (!seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

/**
 * Pure: build the subprocess launch plan (argv/env/stdin/promptFile) from an adapter + task.
 * No subprocess, no I/O. `adapter.env_allowlist` is the already-composed effective allowlist
 * (the orchestrator unions security + adapter via composeEnvAllowlist before calling — LO-002).
 * For prompt_via='file', the path lives under `workerStateDir` (outside the captured worktree)
 * so it never contaminates the diff; the runner writes/deletes it (MD-008/MD-003).
 */
export function buildWorkerCommand(
  adapter: WorkerAdapterConfig,
  task: WorkerTask,
  worktreePath: string,
  workerStateDir: string
): WorkerLaunchPlan {
  const args = [...adapter.args];
  let stdin: string | null = null;
  let promptFile: { path: string; contents: string } | null = null;

  switch (adapter.prompt_via) {
    case 'arg':
      if (adapter.prompt_arg_flag !== null) {
        args.push(adapter.prompt_arg_flag, task.prompt);
      } else {
        args.push(task.prompt);
      }
      break;
    case 'stdin':
      stdin = task.prompt;
      break;
    case 'file': {
      const path = join(workerStateDir, 'prompt.txt');
      promptFile = { path, contents: task.prompt };
      if (adapter.prompt_file_flag !== null) {
        args.push(adapter.prompt_file_flag, path);
      } else {
        args.push(path);
      }
      break;
    }
  }

  // Allowlisted env only — never spread process.env. HOME forced to the isolated throwaway home.
  const env: Record<string, string> = {};
  for (const name of adapter.env_allowlist) {
    const val = process.env[name];
    if (val !== undefined) env[name] = val;
  }
  env.HOME = join(worktreePath, '.home');

  return { command: adapter.command, args, env, stdin, promptFile };
}

export interface RoutingResolution {
  implementer: string;
  reviewer: string;
  degraded: boolean;
}

/**
 * Resolve implementer + reviewer adapter names for a task type (pure). Prefers the configured
 * reviewer when enabled and distinct from the implementer; otherwise any other enabled adapter;
 * otherwise the implementer with degraded=true (caller enforces allow_same_model_review).
 */
export function resolveRouting(
  taskType: string,
  routing: WorkerRoutingConfig,
  adapters: Record<string, WorkerAdapterConfig>
): RoutingResolution {
  const override = routing.by_task_type?.[taskType];
  const implementer = override?.implementer ?? routing.default_implementer;
  const configuredReviewer = override?.reviewer ?? routing.default_reviewer;
  const isEnabled = (n: string): boolean => adapters[n]?.enabled === true;

  if (configuredReviewer !== implementer && isEnabled(configuredReviewer)) {
    return { implementer, reviewer: configuredReviewer, degraded: false };
  }
  const other = Object.keys(adapters).find((n) => n !== implementer && isEnabled(n));
  if (other) {
    return { implementer, reviewer: other, degraded: false };
  }
  return { implementer, reviewer: implementer, degraded: true };
}
