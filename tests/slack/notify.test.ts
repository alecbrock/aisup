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
let msgHandler: ((args: { message: Record<string, unknown>; say: (t: string) => Promise<void> }) => Promise<void>) | null = null;
vi.mock('@slack/bolt', () => {
  const FakeApp = vi.fn().mockImplementation(() => ({
    message: vi.fn().mockImplementation((fn) => { msgHandler = fn; }),
    action: vi.fn(), view: vi.fn(),
    start: vi.fn().mockResolvedValue(undefined), stop: vi.fn().mockResolvedValue(undefined),
    client: {
      auth: { test: vi.fn().mockResolvedValue({ ok: true }) },
      chat: { postMessage: vi.fn().mockImplementation((a) => { posted.push(a); return Promise.resolve({ ts: 't' }); }) },
      views: { open: vi.fn().mockResolvedValue({}) },
    },
  }));
  return { App: FakeApp };
});

import { SlackService } from '../../src/slack/service.js';
import type { SlackConfig } from '../../src/config/schema.js';

function slackConfig(): SlackConfig {
  return { enabled: true, bot_token_env: 'AISUP_SLACK_BOT_TOKEN', app_token_env: 'AISUP_SLACK_APP_TOKEN',
    allowed_user_ids: ['U1'], relay_output_enabled: false, cmd_require_confirmation: false,
    redaction_patterns: [], interactivity_enabled: true };
}

describe('!notify verbosity control (A5)', () => {
  let dir: string;
  let svc: SlackService;
  const say = vi.fn().mockResolvedValue(undefined);

  async function notify(level: string): Promise<void> {
    await msgHandler!({ message: { text: `!notify ${level}`, user: 'U1', channel: 'C1' }, say });
  }
  function rows(): Array<Record<string, unknown>> { return posted.filter((p) => p.thread_ts); }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'aisup-notify-'));
    posted.length = 0; say.mockClear();
    svc = new SlackService({
      config: slackConfig(),
      sessionManager: { getActiveSession: () => null, stopSession: async () => {} },
      tmuxSocket: 'sock',
      journal: { append: async () => {} },
      channelMapPath: join(dir, 'channel-map.json'),
      cardStorePath: join(dir, 'slack-cards.json'),
      notificationsConfig: { verbosity: 'normal' },
      permissionsConfig: { enabled: true, detection_patterns: [], approval_key: 'y', denial_key: 'n',
        policy: { allowlist: [], denylist: [], default_action: 'deny' }, slack_routing: true, grant_ttl_seconds: null },
    });
    await svc.start();
    (svc as unknown as { channelMap: Map<string, string> }).channelMap.set('s1', 'C1');
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('!notify silent stops feed rows but a permission card still posts', async () => {
    await notify('silent');
    await svc.postActivity('s1', { toolName: 'Edit', toolInput: { file_path: 'a.ts', old_string: 'a', new_string: 'b' } });
    expect(rows()).toHaveLength(0); // feed suppressed

    posted.length = 0;
    await svc.notifyPermissionRequest('s1', { tool: 'Bash', detail: 'git push', raw: 'r', request_id: 'rq-1' });
    expect(posted.length).toBe(1); // card still posts under silent
  });

  it('!notify verbose makes a Read post a row; !notify normal stops it again', async () => {
    await notify('verbose');
    await svc.postActivity('s1', { toolName: 'Read', toolInput: { file_path: 'README.md' } });
    expect(rows().length).toBeGreaterThan(0);

    posted.length = 0;
    await notify('normal');
    await svc.postActivity('s1', { toolName: 'Read', toolInput: { file_path: 'README.md' } });
    expect(rows()).toHaveLength(0);
  });

  it('an unknown level prints usage', async () => {
    await notify('loud');
    expect(say).toHaveBeenCalledWith(expect.stringContaining('silent|normal|verbose'));
  });

  it('verbosity persists across a restart (new service from the same store)', async () => {
    await notify('silent');
    const reloaded = new SlackService({
      config: slackConfig(),
      sessionManager: { getActiveSession: () => null, stopSession: async () => {} },
      tmuxSocket: 'sock',
      journal: { append: async () => {} },
      channelMapPath: join(dir, 'channel-map.json'),
      cardStorePath: join(dir, 'slack-cards.json'),
      notificationsConfig: { verbosity: 'normal' },
    });
    await reloaded.start();
    (reloaded as unknown as { channelMap: Map<string, string> }).channelMap.set('s1', 'C1');
    posted.length = 0;
    await reloaded.postActivity('s1', { toolName: 'Edit', toolInput: { file_path: 'a.ts', old_string: 'a', new_string: 'b' } });
    expect(posted.filter((p) => p.thread_ts)).toHaveLength(0); // still silent after restart
  });
});
