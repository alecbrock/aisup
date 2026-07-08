import { describe, it, expect } from 'vitest';
import {
  permissionCard,
  activityRow,
  expandModal,
  statusBlocks,
  PERM_ACTIONS,
  ACTIVITY_EXPAND_ACTION,
} from '../../src/slack/blocks.js';

/** Pull every button across a block array as {action_id, value, text}. */
function buttons(blocks: unknown[]): Array<{ action_id?: string; value?: string; text?: string }> {
  const out: Array<{ action_id?: string; value?: string; text?: string }> = [];
  for (const b of blocks as Array<{ type: string; elements?: unknown[]; accessory?: unknown }>) {
    const els = [...(b.elements ?? []), ...(b.accessory ? [b.accessory] : [])];
    for (const el of els as Array<{ type?: string; action_id?: string; value?: string; text?: { text?: string } }>) {
      if (el.type === 'button') out.push({ action_id: el.action_id, value: el.value, text: el.text?.text });
    }
  }
  return out;
}

describe('Block Kit builders', () => {
  it('permission card carries the request_id in every button value and routes by action_id', () => {
    const blocks = permissionCard({
      requestId: 'req-1',
      tool: 'Bash',
      summary: 'run git status',
      preview: 'git status',
    });
    const btns = buttons(blocks);
    const ids = btns.map((b) => b.action_id);
    expect(ids).toContain(PERM_ACTIONS.approve);
    expect(ids).toContain(PERM_ACTIONS.deny);
    // No "approve for session" unless explicitly enabled (A0 keystroke unconfirmed).
    expect(ids).not.toContain(PERM_ACTIONS.approveSession);
    expect(btns.every((b) => b.value === 'req-1')).toBe(true);
    // No "type !permit" instruction text anywhere.
    expect(JSON.stringify(blocks)).not.toMatch(/!permit/);
  });

  it('permission card includes the approve-for-session button only when enabled', () => {
    const blocks = permissionCard({
      requestId: 'req-2',
      tool: 'Bash',
      summary: 'x',
      includeApproveForSession: true,
    });
    expect(buttons(blocks).map((b) => b.action_id)).toContain(PERM_ACTIONS.approveSession);
  });

  it('activity row exposes an Expand button bound to the request_id', () => {
    const blocks = activityRow({ requestId: 'act-9', icon: '✏️', summary: 'edit src/app.ts' });
    const btns = buttons(blocks);
    expect(btns).toHaveLength(1);
    expect(btns[0].action_id).toBe(ACTIVITY_EXPAND_ACTION);
    expect(btns[0].value).toBe('act-9');
  });

  it('expand modal slices the title to Slack 24-char limit and wraps content in a code block', () => {
    const view = expandModal({ title: 'A very long modal title that exceeds limit', content: 'diff --git a b' });
    expect(view.type).toBe('modal');
    expect(view.title.text.length).toBeLessThanOrEqual(24);
    expect(JSON.stringify(view.blocks)).toContain('diff --git a b');
  });

  it('status blocks render a header and one section per line', () => {
    const blocks = statusBlocks({ title: 'Health', lines: ['a: 1', 'b: 2'] });
    expect((blocks[0] as { type: string }).type).toBe('header');
    expect(JSON.stringify(blocks)).toContain('a: 1');
    expect(JSON.stringify(blocks)).toContain('b: 2');
  });
});
