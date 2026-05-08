/**
 * Tests for SlackService command dispatch, allowed-user enforcement,
 * bot-message filtering, and channel map persistence.
 * Bolt App is mocked to avoid real Slack connections.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Mock tmux operations
vi.mock('../../src/session/tmux.js', () => ({
  sendInterrupt: vi.fn(),
  sendEnter: vi.fn(),
  sendText: vi.fn(),
  captureOutput: vi.fn().mockReturnValue('session output line 1\nsession output line 2'),
  isProcessDead: vi.fn().mockReturnValue(false),
  createTmuxSession: vi.fn().mockResolvedValue(undefined),
  destroyTmuxSession: vi.fn(),
  stopPipePane: vi.fn(),
  startOutputLog: vi.fn(),
  listSessions: vi.fn().mockReturnValue([]),
  getSessionId: vi.fn().mockReturnValue('$1'),
  getPaneId: vi.fn().mockReturnValue('%1'),
  respawnPane: vi.fn(),
  getPaneDeadStatus: vi.fn().mockReturnValue(''),
  isPipePaneActive: vi.fn().mockReturnValue(true),
}));

// Mock Bolt App with a fake implementation
vi.mock('@slack/bolt', () => {
  const handlers: Record<string, Function[]> = {};
  const FakeApp = vi.fn().mockImplementation(() => ({
    message: vi.fn().mockImplementation((fn: Function) => {
      handlers['message'] ??= [];
      handlers['message'].push(fn);
    }),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    client: {
      conversations: {
        create: vi.fn().mockResolvedValue({ channel: { id: 'C123456' } }),
        invite: vi.fn().mockResolvedValue({}),
        archive: vi.fn().mockResolvedValue({}),
      },
      chat: {
        postMessage: vi.fn().mockResolvedValue({}),
      },
    },
    _handlers: handlers,
  }));
  return { App: FakeApp };
});

import { SlackService } from '../../src/slack/service.js';
import * as tmuxModule from '../../src/session/tmux.js';
import type { SlackConfig } from '../../src/config/schema.js';
import type { SessionState } from '../../src/session/types.js';

function makeConfig(overrides: Partial<SlackConfig> = {}): SlackConfig {
  return {
    enabled: true,
    bot_token_env: 'AISUP_SLACK_BOT_TOKEN',
    app_token_env: 'AISUP_SLACK_APP_TOKEN',
    allowed_user_ids: ['U123'],
    relay_output_enabled: false,
    cmd_require_confirmation: false,
    redaction_patterns: [],
    ...overrides,
  };
}

function makeSession(overrides: Partial<SessionState> = {}): SessionState {
  return {
    aisup_session_id: 'sess-001',
    status: 'ACTIVE',
    account: 'primary',
    tmux_name: 'aisup-sess0001',
    tmux_session_id: '$1',
    pane_id: '%1',
    cwd: '/tmp/project',
    launch_started_at: new Date().toISOString(),
    claude_session_id: null,
    transcript_path: null,
    plan_path: null,
    active_skill: null,
    output_log_path: '/tmp/output.log',
    switch_tx: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

describe('SlackService', () => {
  let tmpDir: string;
  let channelMapPath: string;
  let sessionManager: {
    getActiveSession: ReturnType<typeof vi.fn>;
    stopSession: ReturnType<typeof vi.fn>;
  };
  let journal: { append: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'aisup-slack-'));
    channelMapPath = join(tmpDir, 'channel-map.json');
    vi.clearAllMocks();

    sessionManager = {
      getActiveSession: vi.fn().mockReturnValue(makeSession()),
      stopSession: vi.fn().mockResolvedValue(undefined),
    };
    journal = { append: vi.fn().mockResolvedValue(undefined) };

    process.env['AISUP_SLACK_BOT_TOKEN'] = 'xoxb-test';
    process.env['AISUP_SLACK_APP_TOKEN'] = 'xapp-test';
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env['AISUP_SLACK_BOT_TOKEN'];
    delete process.env['AISUP_SLACK_APP_TOKEN'];
  });

  it('should create channel when session starts', async () => {
    const svc = new SlackService({
      config: makeConfig(),
      sessionManager: sessionManager as never,
      tmuxSocket: 'aisup-test',
      journal: journal as never,
      channelMapPath,
    });
    await svc.start();
    const session = makeSession();
    await svc.onSessionStart(session);

    const { App } = await import('@slack/bolt');
    const appInstance = vi.mocked(App).mock.results[0]?.value;
    expect(appInstance.client.conversations.create).toHaveBeenCalledWith(
      expect.objectContaining({ is_private: true })
    );
  });

  it('should invite allowed users to channel on session start', async () => {
    const svc = new SlackService({
      config: makeConfig({ allowed_user_ids: ['U123', 'U456'] }),
      sessionManager: sessionManager as never,
      tmuxSocket: 'aisup-test',
      journal: journal as never,
      channelMapPath,
    });
    await svc.start();
    await svc.onSessionStart(makeSession());

    const { App } = await import('@slack/bolt');
    const appInstance = vi.mocked(App).mock.results[0]?.value;
    expect(appInstance.client.conversations.invite).toHaveBeenCalledTimes(2);
  });

  it('should persist channel map to disk on session start', async () => {
    const svc = new SlackService({
      config: makeConfig(),
      sessionManager: sessionManager as never,
      tmuxSocket: 'aisup-test',
      journal: journal as never,
      channelMapPath,
    });
    await svc.start();
    await svc.onSessionStart(makeSession({ aisup_session_id: 'sess-abc' }));

    expect(existsSync(channelMapPath)).toBe(true);
    const map = JSON.parse(readFileSync(channelMapPath, 'utf8'));
    expect(map['sess-abc']).toBeDefined();
  });

  it('should restore channel map from disk on start', async () => {
    // Pre-write a channel map
    const existingMap = { 'sess-existing': 'C999' };
    const { writeFileSync } = await import('node:fs');
    writeFileSync(channelMapPath, JSON.stringify(existingMap));

    const svc = new SlackService({
      config: makeConfig(),
      sessionManager: sessionManager as never,
      tmuxSocket: 'aisup-test',
      journal: journal as never,
      channelMapPath,
    });
    await svc.start();

    expect(svc.getChannelId('sess-existing')).toBe('C999');
  });

  it('should ignore bot messages (no echo loop)', async () => {
    const svc = new SlackService({
      config: makeConfig(),
      sessionManager: sessionManager as never,
      tmuxSocket: 'aisup-test',
      journal: journal as never,
      channelMapPath,
    });
    await svc.start();

    // Simulate bot message via registered handler
    const { App } = await import('@slack/bolt');
    const appInstance = vi.mocked(App).mock.results[0]?.value;
    const messageHandler = appInstance.message.mock.calls[0]?.[0];
    if (messageHandler) {
      await messageHandler({
        message: { subtype: 'bot_message', text: '!interrupt', user: 'U123', channel: 'C123' },
        say: vi.fn(),
      });
    }

    expect(tmuxModule.sendInterrupt).not.toHaveBeenCalled();
  });

  it('should ignore messages from non-allowed users and log journal event', async () => {
    const svc = new SlackService({
      config: makeConfig({ allowed_user_ids: ['U123'] }),
      sessionManager: sessionManager as never,
      tmuxSocket: 'aisup-test',
      journal: journal as never,
      channelMapPath,
    });
    await svc.start();

    const { App } = await import('@slack/bolt');
    const appInstance = vi.mocked(App).mock.results[0]?.value;
    const messageHandler = appInstance.message.mock.calls[0]?.[0];
    if (messageHandler) {
      await messageHandler({
        message: { text: '!interrupt', user: 'UEVIL', channel: 'C123' },
        say: vi.fn(),
      });
    }

    expect(tmuxModule.sendInterrupt).not.toHaveBeenCalled();
    expect(journal.append).toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'slack.message_ignored' })
    );
  });

  it('should execute !interrupt and call sendInterrupt', async () => {
    const svc = new SlackService({
      config: makeConfig(),
      sessionManager: sessionManager as never,
      tmuxSocket: 'aisup-test',
      journal: journal as never,
      channelMapPath,
    });
    await svc.start();

    const { App } = await import('@slack/bolt');
    const appInstance = vi.mocked(App).mock.results[0]?.value;
    const messageHandler = appInstance.message.mock.calls[0]?.[0];
    if (messageHandler) {
      await messageHandler({
        message: { text: '!interrupt', user: 'U123', channel: 'C123' },
        say: vi.fn(),
      });
    }

    expect(tmuxModule.sendInterrupt).toHaveBeenCalledWith('aisup-test', 'aisup-sess0001');
  });

  it('should execute !status and post redacted output', async () => {
    const svc = new SlackService({
      config: makeConfig(),
      sessionManager: sessionManager as never,
      tmuxSocket: 'aisup-test',
      journal: journal as never,
      channelMapPath,
    });
    await svc.start();

    const say = vi.fn();
    const { App } = await import('@slack/bolt');
    const appInstance = vi.mocked(App).mock.results[0]?.value;
    const messageHandler = appInstance.message.mock.calls[0]?.[0];
    if (messageHandler) {
      await messageHandler({
        message: { text: '!status', user: 'U123', channel: 'C123' },
        say,
      });
    }

    expect(tmuxModule.captureOutput).toHaveBeenCalled();
    expect(say).toHaveBeenCalledWith(expect.stringContaining('output'));
  });

  it('should execute !cmd and send text to tmux', async () => {
    const svc = new SlackService({
      config: makeConfig({ cmd_require_confirmation: false }),
      sessionManager: sessionManager as never,
      tmuxSocket: 'aisup-test',
      journal: journal as never,
      channelMapPath,
    });
    await svc.start();

    const say = vi.fn();
    const { App } = await import('@slack/bolt');
    const appInstance = vi.mocked(App).mock.results[0]?.value;
    const messageHandler = appInstance.message.mock.calls[0]?.[0];
    if (messageHandler) {
      await messageHandler({
        message: { text: '!cmd ls -la', user: 'U123', channel: 'C123' },
        say,
      });
    }

    expect(tmuxModule.sendText).toHaveBeenCalledWith('aisup-test', 'aisup-sess0001', 'ls -la');
    expect(tmuxModule.sendEnter).toHaveBeenCalledWith('aisup-test', 'aisup-sess0001');
  });

  it('should post help reference for !help', async () => {
    const svc = new SlackService({
      config: makeConfig(),
      sessionManager: sessionManager as never,
      tmuxSocket: 'aisup-test',
      journal: journal as never,
      channelMapPath,
    });
    await svc.start();

    const say = vi.fn();
    const { App } = await import('@slack/bolt');
    const appInstance = vi.mocked(App).mock.results[0]?.value;
    const messageHandler = appInstance.message.mock.calls[0]?.[0];
    if (messageHandler) {
      await messageHandler({
        message: { text: '!help', user: 'U123', channel: 'C123' },
        say,
      });
    }

    expect(say).toHaveBeenCalledWith(expect.stringMatching(/interrupt|stop|status|cmd/i));
  });

  it('should return null for unknown session channel ID', async () => {
    const svc = new SlackService({
      config: makeConfig(),
      sessionManager: sessionManager as never,
      tmuxSocket: 'aisup-test',
      journal: journal as never,
      channelMapPath,
    });
    await svc.start();
    expect(svc.getChannelId('nonexistent')).toBeNull();
  });
});
