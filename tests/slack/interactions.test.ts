import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Mock tmux + Bolt exactly like service.test.ts so SlackService can be constructed without Slack.
vi.mock('../../src/session/tmux.js', () => ({
  sendInterrupt: vi.fn(), sendEnter: vi.fn(), sendText: vi.fn(),
  captureOutput: vi.fn().mockReturnValue(''), isProcessDead: vi.fn().mockReturnValue(false),
  createTmuxSession: vi.fn(), destroyTmuxSession: vi.fn(), stopPipePane: vi.fn(),
  startOutputLog: vi.fn(), listSessions: vi.fn().mockReturnValue([]),
}));
vi.mock('@slack/bolt', () => {
  const FakeApp = vi.fn().mockImplementation(() => ({
    message: vi.fn(), action: vi.fn(), view: vi.fn(),
    start: vi.fn().mockResolvedValue(undefined), stop: vi.fn().mockResolvedValue(undefined),
    client: { auth: { test: vi.fn().mockResolvedValue({ ok: true }) }, chat: { postMessage: vi.fn().mockResolvedValue({}) } },
  }));
  return { App: FakeApp };
});

import { InteractionRegistry, parseBlockAction, routeInteraction } from '../../src/slack/interactions.js';
import { SlackService } from '../../src/slack/service.js';
import type { SlackConfig } from '../../src/config/schema.js';
import type { JournalEvent } from '../../src/journal/types.js';

function makeConfig(overrides: Partial<SlackConfig> = {}): SlackConfig {
  return {
    enabled: true, bot_token_env: 'AISUP_SLACK_BOT_TOKEN', app_token_env: 'AISUP_SLACK_APP_TOKEN',
    allowed_user_ids: ['U123'], relay_output_enabled: false, cmd_require_confirmation: false,
    redaction_patterns: [], interactivity_enabled: true, ...overrides,
  };
}

function blockAction(actionId: string, value: string): Record<string, unknown> {
  return {
    type: 'block_actions',
    user: { id: 'U123' },
    actions: [{ action_id: actionId, value, type: 'button' }],
    channel: { id: 'C1' },
    message: { ts: '111.222' },
  };
}

describe('InteractionRegistry', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'aisup-cards-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('round-trips entries through slack-cards.json with 0600 perms', () => {
    const path = join(dir, 'slack-cards.json');
    const reg = new InteractionRegistry(path);
    reg.set({ request_id: 'r1', channel: 'C1', message_ts: '1.2', kind: 'permission', session_id: 's1' });
    expect(existsSync(path)).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);

    const reloaded = new InteractionRegistry(path);
    expect(reloaded.get('r1')).toMatchObject({ request_id: 'r1', channel: 'C1', kind: 'permission', session_id: 's1' });
  });

  it('deletes entries and persists the deletion', () => {
    const path = join(dir, 'slack-cards.json');
    const reg = new InteractionRegistry(path);
    reg.set({ request_id: 'r1', channel: 'C1', message_ts: '1.2', kind: 'permission' });
    reg.delete('r1');
    expect(reg.get('r1')).toBeNull();
    expect(new InteractionRegistry(path).get('r1')).toBeNull();
  });
});

describe('block_actions parsing + routing', () => {
  it('parseBlockAction extracts action_id, request_id and user', () => {
    const parsed = parseBlockAction(blockAction('perm_approve', 'req-7'));
    expect(parsed).toEqual({ action_id: 'perm_approve', request_id: 'req-7', user_id: 'U123' });
  });

  it('routeInteraction resolves by request_id, not channel/session', () => {
    const reg = new InteractionRegistry(join(mkdtempSync(join(tmpdir(), 'aisup-r-')), 'c.json'));
    reg.set({ request_id: 'req-a', channel: 'C1', message_ts: '1.2', kind: 'permission' });
    reg.set({ request_id: 'req-b', channel: 'C1', message_ts: '3.4', kind: 'worker' });
    const route = routeInteraction(blockAction('worker_deny', 'req-b'), reg);
    expect(route.matched).toBe(true);
    if (route.matched) {
      expect(route.entry.request_id).toBe('req-b');
      expect(route.entry.kind).toBe('worker');
      expect(route.action_id).toBe('worker_deny');
    }
  });

  it('routeInteraction reports unmatched for an unknown request_id', () => {
    const reg = new InteractionRegistry(join(mkdtempSync(join(tmpdir(), 'aisup-r-')), 'c.json'));
    expect(routeInteraction(blockAction('perm_approve', 'ghost'), reg).matched).toBe(false);
  });
});

describe('SlackService.handleAction', () => {
  let dir: string;
  let events: JournalEvent[];
  function makeService(cfg: Partial<SlackConfig> = {}): SlackService {
    events = [];
    return new SlackService({
      config: makeConfig(cfg),
      sessionManager: { getActiveSession: () => null, stopSession: async () => {} },
      tmuxSocket: 'sock',
      journal: { append: async (e) => { events.push(e); } },
      channelMapPath: join(dir, 'channel-map.json'),
      cardStorePath: join(dir, 'slack-cards.json'),
    });
  }
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'aisup-svc-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('acks immediately and journals slack.interaction routed by action_id to the request_id', async () => {
    const svc = makeService();
    svc.registerCard({ request_id: 'req-x', channel: 'C1', message_ts: '1.2', kind: 'permission', session_id: 's1' });
    const ack = vi.fn().mockResolvedValue(undefined);
    await svc.handleAction(blockAction('perm_approve', 'req-x'), ack);
    expect(ack).toHaveBeenCalledOnce();
    const ev = events.find((e) => e.event_type === 'slack.interaction');
    expect(ev?.details).toMatchObject({ action_id: 'perm_approve', request_id: 'req-x', kind: 'permission' });
  });

  it('journals slack.interaction_unmatched for an unknown request_id (still acks)', async () => {
    const svc = makeService();
    const ack = vi.fn().mockResolvedValue(undefined);
    await svc.handleAction(blockAction('perm_approve', 'ghost'), ack);
    expect(ack).toHaveBeenCalledOnce();
    expect(events.some((e) => e.event_type === 'slack.interaction_unmatched')).toBe(true);
  });

  it('probeInteractivity journals a warning when interactivity is not asserted, none when it is', async () => {
    const off = makeService({ interactivity_enabled: false });
    await off.probeInteractivity();
    expect(events.some((e) => e.event_type === 'slack.interactivity_unverified')).toBe(true);

    const on = makeService({ interactivity_enabled: true });
    await on.probeInteractivity();
    expect(events.some((e) => e.event_type === 'slack.interactivity_unverified')).toBe(false);
  });
});
