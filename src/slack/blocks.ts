import type { KnownBlock, ModalView, Button } from '@slack/types';

/**
 * Block Kit builders for the interactive Slack surface (Phase A). Pure functions returning Block Kit
 * payloads — no Slack client, no I/O — so block shape is unit-testable. Every interactive element
 * carries `value = request_id` (opaque uuid); the `app.action` handler resolves by id against the
 * interaction registry, never by channel/session alone (collision risk — see plan Risks).
 */

/** action_ids for permission-card buttons. The handler routes on these. */
export const PERM_ACTIONS = {
  approve: 'perm_approve',
  approveSession: 'perm_approve_session',
  deny: 'perm_deny',
} as const;

/** action_id for the activity-row Expand button (opens the diff/command modal). */
export const ACTIVITY_EXPAND_ACTION = 'activity_expand';

/** action_ids for worker-card buttons. */
export const WORKER_ACTIONS = {
  approve: 'worker_approve',
  deny: 'worker_deny',
  diff: 'worker_diff',
} as const;

/** Slack Block Kit hard limits we clamp to. */
const SECTION_TEXT_MAX = 2900;
const MODAL_TITLE_MAX = 24;
const BUTTON_TEXT_MAX = 75;

function clamp(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function button(text: string, actionId: string, value: string, style?: 'primary' | 'danger'): Button {
  const b: Button = {
    type: 'button',
    text: { type: 'plain_text', text: clamp(text, BUTTON_TEXT_MAX), emoji: true },
    action_id: actionId,
    value,
  };
  if (style) b.style = style;
  return b;
}

function codeBlock(content: string): string {
  return `\`\`\`\n${clamp(content, SECTION_TEXT_MAX - 8)}\n\`\`\``;
}

export interface PermissionCardInput {
  requestId: string;
  tool: string;
  /** One-line summary of the requested action. */
  summary: string;
  /** Optional command/diff preview shown inline (kept short; full text goes to the Expand modal). */
  preview?: string;
  /** Include the "Approve for session" button — only when A0 confirmed its keystroke. */
  includeApproveForSession?: boolean;
}

/** Interactive permission card: tool + summary + preview + Approve / (Approve for session) / Deny. */
export function permissionCard(input: PermissionCardInput): KnownBlock[] {
  const blocks: KnownBlock[] = [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `:lock: *Permission requested* — \`${input.tool}\`\n${clamp(input.summary, 300)}` },
    },
  ];
  if (input.preview) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: codeBlock(input.preview) } });
  }
  const actions: Button[] = [button('Approve', PERM_ACTIONS.approve, input.requestId, 'primary')];
  if (input.includeApproveForSession) {
    actions.push(button('Approve for session', PERM_ACTIONS.approveSession, input.requestId));
  }
  actions.push(button('Deny', PERM_ACTIONS.deny, input.requestId, 'danger'));
  blocks.push({ type: 'actions', elements: actions });
  return blocks;
}

export interface PermissionResolvedInput {
  tool: string;
  summary: string;
  /** Outcome line, e.g. ":white_check_mark: Approved by <@U123>". */
  outcome: string;
}

/** Blocks for a permission card AFTER a decision — replaces the buttons with the outcome in place. */
export function permissionResolvedBlocks(input: PermissionResolvedInput): KnownBlock[] {
  return [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `:lock: \`${input.tool}\` — ${clamp(input.summary, 300)}\n${input.outcome}` },
    },
  ];
}

export interface ActivityRowInput {
  requestId: string;
  /** Leading glyph (e.g. ✏️ edit, ▶️ command). */
  icon: string;
  /** Compact one-line summary. */
  summary: string;
  /** Whether to offer an Expand button (false for rows with nothing more to show). */
  expandable?: boolean;
}

/** Compact activity-feed row with an optional Expand button opening the full diff/command modal. */
export function activityRow(input: ActivityRowInput): KnownBlock[] {
  const expandable = input.expandable ?? true;
  const section: KnownBlock = {
    type: 'section',
    text: { type: 'mrkdwn', text: `${input.icon} ${clamp(input.summary, 300)}` },
  };
  if (expandable) {
    (section as { accessory?: Button }).accessory = button('Expand', ACTIVITY_EXPAND_ACTION, input.requestId);
  }
  return [section];
}

export interface ExpandModalInput {
  title: string;
  /** Optional heading shown above the content. */
  heading?: string;
  /** Body content rendered in a code block (diff or command). */
  content: string;
}

/** Modal view for the Expand action — shows the full command or unified diff. */
export function expandModal(input: ExpandModalInput): ModalView {
  const blocks: KnownBlock[] = [];
  if (input.heading) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: clamp(input.heading, 300) } });
  }
  blocks.push({ type: 'section', text: { type: 'mrkdwn', text: codeBlock(input.content) } });
  return {
    type: 'modal',
    title: { type: 'plain_text', text: clamp(input.title, MODAL_TITLE_MAX) },
    close: { type: 'plain_text', text: 'Close' },
    blocks,
  };
}

export interface WorkerCardInput {
  requestId: string;
  /** Task title / one-line description. */
  title: string;
  /** Patch summary (e.g. "3 files changed, +40 −12"). */
  summary: string;
  /** Short inline patch preview; the full sanitized patch goes to the Expand-diff modal. */
  preview?: string;
}

/** Interactive worker card: task title + patch summary + Expand diff / Approve / Deny buttons. */
export function workerCard(input: WorkerCardInput): KnownBlock[] {
  const blocks: KnownBlock[] = [
    { type: 'section', text: { type: 'mrkdwn', text: `:robot_face: *Worker ready for review* — ${clamp(input.title, 280)}\n${clamp(input.summary, 200)}` } },
  ];
  if (input.preview) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: codeBlock(input.preview) } });
  }
  blocks.push({
    type: 'actions',
    elements: [
      button('Expand diff', WORKER_ACTIONS.diff, input.requestId),
      button('Approve', WORKER_ACTIONS.approve, input.requestId, 'primary'),
      button('Deny', WORKER_ACTIONS.deny, input.requestId, 'danger'),
    ],
  });
  return blocks;
}

/** Blocks for a worker card AFTER a decision — replaces the buttons with the outcome in place. */
export function workerResolvedBlocks(input: { title: string; outcome: string }): KnownBlock[] {
  return [
    { type: 'section', text: { type: 'mrkdwn', text: `:robot_face: ${clamp(input.title, 280)}\n${input.outcome}` } },
  ];
}

export interface StatusBlocksInput {
  title: string;
  lines: string[];
}

/** Generic status display: a header followed by one section per line (used by observability cards). */
export function statusBlocks(input: StatusBlocksInput): KnownBlock[] {
  const blocks: KnownBlock[] = [
    { type: 'header', text: { type: 'plain_text', text: clamp(input.title, 150), emoji: true } },
  ];
  for (const line of input.lines) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: clamp(line, SECTION_TEXT_MAX) } });
  }
  return blocks;
}
