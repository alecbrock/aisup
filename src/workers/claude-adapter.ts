import { join } from 'node:path';
import type { WorkerLaunchPlan } from './adapter.js';

/**
 * Claude-as-worker adapter: run `claude -p --output-format json` in a worktree under a scorer-selected
 * account's real auth (`CLAUDE_CONFIG_DIR`) with an isolated HOME, and parse the JSON result for the
 * final text + token usage. This is the single change point if a future Claude CLI reshapes its output.
 */

/** The minimal account view the adapter needs: a name and the on-disk config dir holding its auth. */
export interface ClaudeWorkerAccount {
  name: string;
  config_dir: string;
}

export interface ClaudeWorkerOptions {
  account: ClaudeWorkerAccount;
  prompt: string;
  /** The worktree the worker edits; HOME is isolated to `<worktreePath>/.home`. */
  worktreePath: string;
  /** Effective env allowlist (security ∪ adapter) — only these names are copied from process.env. */
  envAllowlist: string[];
  /** Non-interactive permission mode; `bypassPermissions` lets the headless worker Edit/Write without prompts. */
  permissionMode?: string;
  /** Optional model override (`--model`); omitted when null/undefined. */
  model?: string | null;
}

/** Tokens charged for a Claude worker run (input + output; cache tokens excluded from the budget basis). */
export interface ClaudeWorkerUsage {
  input_tokens: number;
  output_tokens: number;
}

export interface ClaudeResultParse {
  /** Final assistant text (the `result` field of the terminal `{type:'result'}` element). */
  result: string;
  usage: ClaudeWorkerUsage | null;
  total_cost_usd: number | null;
}

const DEFAULT_PERMISSION_MODE = 'bypassPermissions';

/**
 * Build the `claude -p --output-format json` launch plan for a selected account (pure; no I/O).
 * The prompt is the final positional arg; env is allowlisted + `CLAUDE_CONFIG_DIR` (real auth) +
 * `HOME=<worktree>/.home` (isolation), mirroring `buildWorkerCommand`'s env handling.
 */
export function buildClaudeWorkerCommand(opts: ClaudeWorkerOptions): WorkerLaunchPlan {
  const args = ['-p', '--permission-mode', opts.permissionMode ?? DEFAULT_PERMISSION_MODE, '--output-format', 'json'];
  if (opts.model) {
    args.push('--model', opts.model);
  }
  args.push(opts.prompt);

  const env: Record<string, string> = {};
  for (const name of opts.envAllowlist) {
    const val = process.env[name];
    if (val !== undefined) env[name] = val;
  }
  env.CLAUDE_CONFIG_DIR = opts.account.config_dir;
  env.HOME = join(opts.worktreePath, '.home');

  return { command: 'claude', args, env, stdin: null, promptFile: null };
}

interface ResultElement {
  type?: unknown;
  result?: unknown;
  total_cost_usd?: unknown;
  usage?: { input_tokens?: unknown; output_tokens?: unknown } | null;
}

function isResultElement(v: unknown): v is ResultElement {
  return typeof v === 'object' && v !== null && (v as { type?: unknown }).type === 'result';
}

const EMPTY: ClaudeResultParse = { result: '', usage: null, total_cost_usd: null };

/**
 * Parse `claude -p --output-format json` stdout. Accepts either the array-of-stream-events shape
 * (terminal `{type:'result'}` element) or a single result object. Fail-soft: unparseable output or
 * a missing result element yields `{ result: '', usage: null, total_cost_usd: null }`.
 */
export function parseClaudeResult(stdout: string): ClaudeResultParse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return EMPTY;
  }

  let element: ResultElement | null = null;
  if (Array.isArray(parsed)) {
    for (let i = parsed.length - 1; i >= 0; i--) {
      if (isResultElement(parsed[i])) {
        element = parsed[i] as ResultElement;
        break;
      }
    }
  } else if (isResultElement(parsed)) {
    element = parsed;
  }
  if (!element) return EMPTY;

  const result = typeof element.result === 'string' ? element.result : '';
  const cost = typeof element.total_cost_usd === 'number' ? element.total_cost_usd : null;
  let usage: ClaudeWorkerUsage | null = null;
  if (element.usage && typeof element.usage === 'object') {
    const inTok = element.usage.input_tokens;
    const outTok = element.usage.output_tokens;
    if (typeof inTok === 'number' && typeof outTok === 'number') {
      usage = { input_tokens: inTok, output_tokens: outTok };
    }
  }
  return { result, usage, total_cost_usd: cost };
}
