import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('../../src/session/tmux.js', () => ({
  sendInterrupt: vi.fn(), sendEnter: vi.fn(), sendText: vi.fn(),
  captureOutput: vi.fn().mockReturnValue(''), isProcessDead: vi.fn().mockReturnValue(false),
  createTmuxSession: vi.fn(), destroyTmuxSession: vi.fn(), stopPipePane: vi.fn(),
  startOutputLog: vi.fn(), listSessions: vi.fn().mockReturnValue([]),
}));
const posted: Array<Record<string, unknown>> = [];
const updated: Array<Record<string, unknown>> = [];
const opened: Array<Record<string, unknown>> = [];
let msgHandler: ((args: { message: Record<string, unknown>; say: (t: string) => Promise<void> }) => Promise<void>) | null = null;
vi.mock('@slack/bolt', () => {
  const FakeApp = vi.fn().mockImplementation(() => ({
    message: vi.fn().mockImplementation((fn) => { msgHandler = fn; }), action: vi.fn(), view: vi.fn(),
    start: vi.fn().mockResolvedValue(undefined), stop: vi.fn().mockResolvedValue(undefined),
    client: {
      auth: { test: vi.fn().mockResolvedValue({ ok: true }) },
      chat: {
        postMessage: vi.fn().mockImplementation((a) => { posted.push(a); return Promise.resolve({ ts: 'w-ts' }); }),
        update: vi.fn().mockImplementation((a) => { updated.push(a); return Promise.resolve({}); }),
      },
      views: { open: vi.fn().mockImplementation((a) => { opened.push(a); return Promise.resolve({}); }) },
    },
  }));
  return { App: FakeApp };
});

import { SlackService } from '../../src/slack/service.js';
import { WORKER_ACTIONS } from '../../src/slack/blocks.js';
import type { SlackConfig } from '../../src/config/schema.js';

const PATCH = 'diff --git a/x b/x\n--- a/x\n+++ b/x\n-old line\n+new line';

function blockAction(actionId: string, value: string): Record<string, unknown> {
  return { type: 'block_actions', user: { id: 'U1' }, trigger_id: 'tg-1',
    actions: [{ action_id: actionId, value }], channel: { id: 'C1' }, message: { ts: 'w-ts' } };
}

describe('Slack worker cards (A7)', () => {
  let dir: string;
  const approvals: string[] = [];
  const denials: string[] = [];

  function makeService(over: { approveOk?: boolean } = {}): SlackService {
    return new SlackService({
      config: { enabled: true, bot_token_env: 'AISUP_SLACK_BOT_TOKEN', app_token_env: 'AISUP_SLACK_APP_TOKEN',
        allowed_user_ids: ['U1'], relay_output_enabled: false, cmd_require_confirmation: false,
        redaction_patterns: [], interactivity_enabled: true } as SlackConfig,
      sessionManager: { getActiveSession: () => null, stopSession: async () => {} },
      tmuxSocket: 'sock',
      journal: { append: async () => {} },
      channelMapPath: join(dir, 'channel-map.json'),
      cardStorePath: join(dir, 'slack-cards.json'),
      getWorkerDiff: (id) => ({ title: `task ${id}`, patch: PATCH }),
      onWorkerApprove: async (id) => { approvals.push(id); return { ok: over.approveOk ?? true }; },
      onWorkerDeny: async (id) => { denials.push(id); return { ok: true }; },
    });
  }
  async function start(svc: SlackService): Promise<void> {
    await svc.start();
    (svc as unknown as { channelMap: Map<string, string> }).channelMap.set('s1', 'C1');
  }
  function reqId(): string | undefined {
    const blocks = (posted.find((p) => JSON.stringify(p).includes(WORKER_ACTIONS.approve))?.blocks ?? []) as Array<{ type: string; elements?: Array<{ value?: string }> }>;
    for (const b of blocks) if (b.type === 'actions') return b.elements?.[0]?.value;
    return undefined;
  }
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'aisup-wc-')); posted.length = 0; updated.length = 0; opened.length = 0; approvals.length = 0; denials.length = 0; });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('a worker awaiting_approval posts a card with Expand/Approve/Deny and registers it', async () => {
    const svc = makeService();
    await start(svc);
    await svc.notifyWorkerAwaitingApproval('s1', 'wk-1');
    const s = JSON.stringify(posted);
    expect(s).toContain(WORKER_ACTIONS.diff);
    expect(s).toContain(WORKER_ACTIONS.approve);
    expect(s).toContain(WORKER_ACTIONS.deny);
    const id = reqId();
    expect(svc.getCard(id!)).toMatchObject({ kind: 'worker' });
  });

  it('Expand diff opens a modal with the sanitized patch', async () => {
    const svc = makeService();
    await start(svc);
    await svc.notifyWorkerAwaitingApproval('s1', 'wk-2');
    await svc.handleAction(blockAction(WORKER_ACTIONS.diff, reqId()!), vi.fn().mockResolvedValue(undefined));
    expect(JSON.stringify(opened.at(-1))).toContain('+new line');
  });

  it('Approve merges via the existing handler and updates the card', async () => {
    const svc = makeService();
    await start(svc);
    await svc.notifyWorkerAwaitingApproval('s1', 'wk-3');
    await svc.handleAction(blockAction(WORKER_ACTIONS.approve, reqId()!), vi.fn().mockResolvedValue(undefined));
    expect(approvals).toEqual(['wk-3']);
    expect(JSON.stringify(updated.at(-1))).toMatch(/Approved/i);
  });

  it('Deny routes to the deny handler and updates the card', async () => {
    const svc = makeService();
    await start(svc);
    await svc.notifyWorkerAwaitingApproval('s1', 'wk-4');
    await svc.handleAction(blockAction(WORKER_ACTIONS.deny, reqId()!), vi.fn().mockResolvedValue(undefined));
    expect(denials).toEqual(['wk-4']);
    expect(JSON.stringify(updated.at(-1))).toMatch(/Denied/i);
  });

  it('a failed merge annotates the card with the reason and keeps it', async () => {
    const svc = makeService({ approveOk: false });
    await start(svc);
    await svc.notifyWorkerAwaitingApproval('s1', 'wk-5');
    const id = reqId()!;
    await svc.handleAction(blockAction(WORKER_ACTIONS.approve, id), vi.fn().mockResolvedValue(undefined));
    expect(svc.getCard(id)).not.toBeNull(); // not dropped on failure
  });

  it('!worker diff <id> prints the sanitized patch', async () => {
    const svc = makeService();
    await start(svc);
    const say = vi.fn().mockResolvedValue(undefined);
    await msgHandler!({ message: { text: '!worker diff wk-9', user: 'U1', channel: 'C1' }, say });
    expect(say).toHaveBeenCalledWith(expect.stringContaining('+new line'));
  });
});
