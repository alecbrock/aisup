/**
 * Parse `codex exec --json` stream output (NDJSON).
 *
 * codex emits one JSON object per line; the elements this module cares about are:
 *   {"type":"item.completed","item":{"type":"agent_message","text":"…"}}  → final assistant text
 *   {"type":"turn.completed","usage":{input_tokens,cached_input_tokens,output_tokens,reasoning_output_tokens}}
 * Reasoning / thread.started / turn.started lines are tolerated and ignored.
 * This is the single change point if a future codex-cli version reshapes its `--json` output.
 */

/** Token usage reported by codex on `turn.completed`. */
export interface CodexUsage {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
}

/** Result of parsing a codex `--json` stream: the final agent message + token usage (null if absent). */
export interface CodexJsonParseResult {
  finalText: string;
  usage: CodexUsage | null;
}

interface AgentMessageItem {
  type: 'agent_message';
  text: string;
}

function isAgentMessage(item: unknown): item is AgentMessageItem {
  return (
    typeof item === 'object' &&
    item !== null &&
    (item as { type?: unknown }).type === 'agent_message' &&
    typeof (item as { text?: unknown }).text === 'string'
  );
}

function toUsage(raw: unknown): CodexUsage | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const u = raw as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === 'number' ? v : 0);
  return {
    input_tokens: num(u.input_tokens),
    cached_input_tokens: num(u.cached_input_tokens),
    output_tokens: num(u.output_tokens),
    reasoning_output_tokens: num(u.reasoning_output_tokens),
  };
}

/**
 * Walk the NDJSON stream, returning the LAST `agent_message` text and the `turn.completed` usage.
 * Malformed (non-JSON) lines are skipped without throwing; absent data yields `{ finalText: '', usage: null }`.
 */
export function parseCodexJsonStream(stdout: string): CodexJsonParseResult {
  let finalText = '';
  let usage: CodexUsage | null = null;

  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue; // not JSON — skip
    }
    if (typeof obj !== 'object' || obj === null) continue;
    const evt = obj as { type?: unknown; item?: unknown; usage?: unknown };
    if (evt.type === 'item.completed' && isAgentMessage(evt.item)) {
      finalText = evt.item.text;
    } else if (evt.type === 'turn.completed') {
      usage = toUsage(evt.usage);
    }
  }

  return { finalText, usage };
}

/** Tokens charged against the codex budget: input + output (cached input and reasoning output excluded). */
export function chargeableTokens(usage: CodexUsage): number {
  return usage.input_tokens + usage.output_tokens;
}
