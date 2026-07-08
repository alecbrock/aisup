import stripAnsi from 'strip-ansi';

/**
 * Activity-feed classification + rendering (A4). Pure functions — no Slack client, no I/O — so the
 * row/diff shape and redaction are unit-testable. The daemon feeds `PostToolUse` tool activity here
 * (hook-primary path; the transcript-`.jsonl`-tail is the documented follow-up resilience add).
 */

export type Verbosity = 'silent' | 'normal' | 'verbose';

/** Tools that produce a row at `normal`; everything else only at `verbose`. */
const MEANINGFUL = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash', 'Task']);

export interface ActivityInput {
  toolName: string;
  toolInput: unknown;
  toolResponse?: unknown;
}

/** Does this tool warrant a feed row at the given verbosity? `silent` suppresses the whole feed. */
export function isMeaningful(toolName: string, verbosity: Verbosity): boolean {
  if (verbosity === 'silent') return false;
  if (verbosity === 'verbose') return true;
  return MEANINGFUL.has(toolName);
}

function field(input: unknown, key: string): string | undefined {
  const v = (input as Record<string, unknown> | null | undefined)?.[key];
  return typeof v === 'string' ? v : undefined;
}

function basename(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] || path;
}

function clean(text: string, redact: (s: string) => string): string {
  return redact(stripAnsi(text));
}

export interface ActivityRowData {
  icon: string;
  summary: string;
}

/** Compact one-line row (icon + summary), ANSI-stripped and redacted. */
export function renderActivityRow(input: ActivityInput, redact: (s: string) => string): ActivityRowData {
  const { toolName, toolInput } = input;
  if (toolName === 'Edit' || toolName === 'MultiEdit' || toolName === 'NotebookEdit') {
    return { icon: '✏️', summary: `edit \`${clean(field(toolInput, 'file_path') ?? '?', redact)}\`` };
  }
  if (toolName === 'Write') {
    return { icon: '📝', summary: `write \`${clean(field(toolInput, 'file_path') ?? '?', redact)}\`` };
  }
  if (toolName === 'Bash') {
    return { icon: '▶️', summary: `\`${clean(field(toolInput, 'command') ?? '?', redact).slice(0, 200)}\`` };
  }
  if (toolName === 'Task') {
    return { icon: '🧵', summary: clean(field(toolInput, 'description') ?? 'sub-agent task', redact) };
  }
  if (toolName === 'Read' || toolName === 'Grep' || toolName === 'Glob') {
    const target = field(toolInput, 'file_path') ?? field(toolInput, 'pattern') ?? field(toolInput, 'path') ?? '';
    return { icon: '🔍', summary: `${toolName.toLowerCase()} \`${clean(target, redact)}\`` };
  }
  return { icon: '🔧', summary: clean(toolName, redact) };
}

export interface ActivityDetail {
  title: string;
  content: string;
}

/** Build a minimal unified-style diff: removed lines from `before`, added lines from `after`. */
function unifiedDiff(path: string, before: string, after: string): string {
  const head = `--- a/${path}\n+++ b/${path}`;
  const minus = before.length ? before.split('\n').map((l) => `-${l}`).join('\n') : '';
  const plus = after.length ? after.split('\n').map((l) => `+${l}`).join('\n') : '';
  return [head, minus, plus].filter(Boolean).join('\n');
}

/** Full Expand content: unified diff for Edit/Write, exact command for Bash. ANSI-free + redacted. */
export function renderActivityDetail(input: ActivityInput, redact: (s: string) => string): ActivityDetail {
  const { toolName, toolInput } = input;
  if (toolName === 'Edit' || toolName === 'MultiEdit' || toolName === 'NotebookEdit') {
    const path = field(toolInput, 'file_path') ?? '?';
    const before = field(toolInput, 'old_string') ?? '';
    const after = field(toolInput, 'new_string') ?? '';
    return { title: `Edit ${basename(path)}`, content: clean(unifiedDiff(path, before, after), redact) };
  }
  if (toolName === 'Write') {
    const path = field(toolInput, 'file_path') ?? '?';
    const after = field(toolInput, 'content') ?? '';
    return { title: `Write ${basename(path)}`, content: clean(unifiedDiff(path, '', after), redact) };
  }
  if (toolName === 'Bash') {
    return { title: 'Bash command', content: clean(field(toolInput, 'command') ?? '', redact) };
  }
  const target = field(toolInput, 'file_path') ?? field(toolInput, 'pattern') ?? field(toolInput, 'path') ?? '';
  return { title: toolName, content: clean(target || JSON.stringify(toolInput ?? {}), redact) };
}
