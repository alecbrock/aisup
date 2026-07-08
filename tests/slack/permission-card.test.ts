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
vi.mock('@slack/bolt', () => {
  const FakeApp = vi.fn().mockImplementation(() => ({
    message: vi.fn(), action: vi.fn(), view: vi.fn(),
    start: vi.fn().mockResolvedValue(undefined), stop: vi.fn().mockResolvedValue(undefined),
    client: {
      auth: { test: vi.fn().mockResolvedValue({ ok: true }) },
      chat: {
        postMessage: vi.fn().mockImplementation((a) => { posted.push(a); return Promise.resolve({ ts: '999.111' }); }),
        update: vi.fn().mockImplementation((a) => { updated.push(a); return Promise.resolve({}); }),
      },
    },
  }));
  return { App: FakeApp };
});

import { SlackService } from '../../src/slack/service.js';
import type { SlackConfig, PermissionsConfig } from '../../src/config/schema.js';
import type { JournalEvent } from '../../src/journal/types.js';
import type { PermissionRequest } from '../../src/permissions/types.js';
import { PERM_ACTIONS } from '../../src/slack/blocks.js';

function slackConfig(): SlackConfig {
  return {
    enabled: true, bot_token_env: 'AISUP_SLACK_BOT_TOKEN', app_token_env: 'AISUP_SLACK_APP_TOKEN',
    allowed_user_ids: ['U123'], relay_output_enabled: false, cmd_require_confirmation: false,
    redaction_patterns: [], interactivity_enabled: true,
  };
}
function permsConfig(over: Partial<PermissionsConfig> = {}): PermissionsConfig {
  return {
    enabled: true, detection_patterns: [], approval_key: 'y', denial_key: 'n',
    policy: { default_action: 'ask', allowlist: [], denylist: [] } as unknown as PermissionsConfig['policy'],
    slack_routing: true, grant_ttl_seconds: 300, ...over,
  };
}

function blockAction(actionId: string, value: string): Record<string, unknown> {
  return { type: 'block_actions', user: { id: 'U123' }, actions: [{ action_id: actionId, value, type: 'button' }],
    channel: { id: 'C1' }, message: { ts: '999.111' } };
}

describe('SlackService permission cards (A2)', () => {
  let dir: string;
  let events: JournalEvent[];
  const grants: Array<{ sessionId: string; requestId?: string }> = [];
  const denies: Array<{ sessionId: string; requestId?: string }> = [];

  function makeService(over: { perms?: Partial<PermissionsConfig>; grantOk?: boolean; denyOk?: boolean } = {}): SlackService {
    events = [];
    const svc = new SlackService({
      config: slackConfig(),
      sessionManager: { getActiveSession: () => null, stopSession: async () => {} },
      tmuxSocket: 'sock',
      journal: { append: async (e) => { events.push(e); } },
      channelMapPath: join(dir, 'channel-map.json'),
      cardStorePath: join(dir, 'slack-cards.json'),
      permissionsConfig: permsConfig(over.perms),
      onPermissionGrant: (sessionId, requestId) => { grants.push({ sessionId, requestId }); return over.grantOk ?? true; },
      onPermissionDeny: (sessionId, requestId) => { denies.push({ sessionId, requestId }); return over.denyOk ?? true; },
    });
    return svc;
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aisup-permcard-'));
    posted.length = 0; updated.length = 0; grants.length = 0; denies.length = 0;
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  async function start(svc: SlackService): Promise<void> {
    await svc.start();
    // start() (re)loads the channel map from disk; seed the session→channel mapping afterwards.
    (svc as unknown as { channelMap: Map<string, string> }).channelMap.set('s1', 'C1');
  }

  const req = (over: Partial<PermissionRequest> = {}): PermissionRequest =>
    ({ tool: 'Bash', detail: 'git push origin main', raw: 'r', request_id: 'rq-1', ...over });

  it('posts an interactive card (Approve/Deny, no "!permit" text) and registers it', async () => {
    const svc = makeService();
    await start(svc);
    await svc.notifyPermissionRequest('s1', req());
    expect(posted).toHaveLength(1);
    const blocks = JSON.stringify(posted[0].blocks);
    expect(blocks).toContain(PERM_ACTIONS.approve);
    expect(blocks).toContain(PERM_ACTIONS.deny);
    expect(blocks).not.toContain(PERM_ACTIONS.approveSession); // no session key configured
    expect(JSON.stringify(posted[0])).not.toMatch(/!permit/);
    expect(svc.getCard('rq-1')).toMatchObject({ request_id: 'rq-1', channel: 'C1', kind: 'permission', session_id: 's1' });
  });

  it('includes Approve-for-session only when approval_session_key is configured', async () => {
    const svc = makeService({ perms: { approval_session_key: '2' } });
    await start(svc);
    await svc.notifyPermissionRequest('s1', req({ request_id: 'rq-2' }));
    expect(JSON.stringify(posted[0].blocks)).toContain(PERM_ACTIONS.approveSession);
  });

  it('tapping Approve resolves with the request_id and updates the card to "Approved"', async () => {
    const svc = makeService();
    await start(svc);
    await svc.notifyPermissionRequest('s1', req({ request_id: 'rq-3' }));
    await svc.handleAction(blockAction(PERM_ACTIONS.approve, 'rq-3'), vi.fn().mockResolvedValue(undefined));
    expect(grants).toEqual([{ sessionId: 's1', requestId: 'rq-3' }]);
    expect(JSON.stringify(updated.at(-1))).toMatch(/Approved/i);
    expect(svc.getCard('rq-3')).toBeNull(); // resolved card removed from registry
  });

  it('tapping Deny resolves with the request_id and updates the card to "Denied"', async () => {
    const svc = makeService();
    await start(svc);
    await svc.notifyPermissionRequest('s1', req({ request_id: 'rq-4' }));
    await svc.handleAction(blockAction(PERM_ACTIONS.deny, 'rq-4'), vi.fn().mockResolvedValue(undefined));
    expect(denies).toEqual([{ sessionId: 's1', requestId: 'rq-4' }]);
    expect(JSON.stringify(updated.at(-1))).toMatch(/Denied/i);
  });

  it('a failed resolution (prompt gone) annotates the card and keeps it (not silently dropped)', async () => {
    const svc = makeService({ grantOk: false });
    await start(svc);
    await svc.notifyPermissionRequest('s1', req({ request_id: 'rq-5' }));
    await svc.handleAction(blockAction(PERM_ACTIONS.approve, 'rq-5'), vi.fn().mockResolvedValue(undefined));
    expect(JSON.stringify(updated.at(-1))).toMatch(/no longer active|could not/i);
    expect(svc.getCard('rq-5')).not.toBeNull(); // kept for a possible retry, not dropped
  });
});
