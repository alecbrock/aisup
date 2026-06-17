/**
 * Tests for SlackService command dispatch, allowed-user enforcement,
 * bot-message filtering, and channel map persistence.
 * Bolt App is mocked to avoid real Slack connections.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
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

  it('routes !permit to onPermissionGrant and confirms success only when the broker acts', async () => {
    const onPermissionGrant = vi.fn().mockResolvedValue(true);
    const svc = new SlackService({
      config: makeConfig(),
      sessionManager: sessionManager as never,
      tmuxSocket: 'aisup-test',
      journal: journal as never,
      channelMapPath,
      onPermissionGrant,
    });
    await svc.start();

    const say = vi.fn();
    const { App } = await import('@slack/bolt');
    const appInstance = vi.mocked(App).mock.results.at(-1)?.value;
    const messageHandler = appInstance.message.mock.calls[0]?.[0];
    await messageHandler?.({ message: { text: '!permit', user: 'U123', channel: 'C123' }, say });

    expect(onPermissionGrant).toHaveBeenCalledWith('sess-001');
    expect(say).toHaveBeenCalledWith(expect.stringMatching(/permission granted/i));
  });

  // F3 regression: when the broker found no actionable prompt, Slack must NOT claim success.
  it('reports failure for !permit when the broker did not send a keystroke', async () => {
    const onPermissionGrant = vi.fn().mockResolvedValue(false);
    const svc = new SlackService({
      config: makeConfig(),
      sessionManager: sessionManager as never,
      tmuxSocket: 'aisup-test',
      journal: journal as never,
      channelMapPath,
      onPermissionGrant,
    });
    await svc.start();

    const say = vi.fn();
    const { App } = await import('@slack/bolt');
    const appInstance = vi.mocked(App).mock.results.at(-1)?.value;
    const messageHandler = appInstance.message.mock.calls[0]?.[0];
    await messageHandler?.({ message: { text: '!permit', user: 'U123', channel: 'C123' }, say });

    expect(say).toHaveBeenCalledWith(expect.stringMatching(/no pending permission|expired|already been resolved/i));
    expect(say).not.toHaveBeenCalledWith(expect.stringMatching(/permission granted/i));
  });

  it('routes !deny to onPermissionDeny and confirms success only when the broker acts', async () => {
    const onPermissionDeny = vi.fn().mockResolvedValue(true);
    const svc = new SlackService({
      config: makeConfig(),
      sessionManager: sessionManager as never,
      tmuxSocket: 'aisup-test',
      journal: journal as never,
      channelMapPath,
      onPermissionDeny,
    });
    await svc.start();

    const say = vi.fn();
    const { App } = await import('@slack/bolt');
    const appInstance = vi.mocked(App).mock.results.at(-1)?.value;
    const messageHandler = appInstance.message.mock.calls[0]?.[0];
    await messageHandler?.({ message: { text: '!deny', user: 'U123', channel: 'C123' }, say });

    expect(onPermissionDeny).toHaveBeenCalledWith('sess-001');
    expect(say).toHaveBeenCalledWith(expect.stringMatching(/permission denied/i));
  });

  it('reports when permission approval is not wired for !permit', async () => {
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
    const appInstance = vi.mocked(App).mock.results.at(-1)?.value;
    const messageHandler = appInstance.message.mock.calls[0]?.[0];
    await messageHandler?.({ message: { text: '!permit', user: 'U123', channel: 'C123' }, say });

    expect(say).toHaveBeenCalledWith(expect.stringMatching(/not enabled|not available/i));
  });

  it('posts a permission request to the session channel via notifyPermissionRequest', async () => {
    const svc = new SlackService({
      config: makeConfig(),
      sessionManager: sessionManager as never,
      tmuxSocket: 'aisup-test',
      journal: journal as never,
      channelMapPath,
    });
    await svc.start();
    await svc.onSessionStart(makeSession({ aisup_session_id: 'sess-perm' }));

    const { App } = await import('@slack/bolt');
    const appInstance = vi.mocked(App).mock.results.at(-1)?.value;
    appInstance.client.chat.postMessage.mockClear();
    await svc.notifyPermissionRequest('sess-perm', { tool: 'Bash', detail: 'git push', raw: 'Bash: git push' });

    expect(appInstance.client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringMatching(/permit|deny/i) })
    );
  });

  it('runs gates on !gate and posts a summary', async () => {
    const onGateRun = vi.fn().mockResolvedValue({ passed: true, results: [{ name: 'typecheck', status: 'passed', exitCode: 0, stdoutTail: '', stderrTail: '', required: true }] });
    const svc = new SlackService({
      config: makeConfig(),
      sessionManager: sessionManager as never,
      tmuxSocket: 'aisup-test',
      journal: journal as never,
      channelMapPath,
      onGateRun,
    });
    await svc.start();

    const say = vi.fn();
    const { App } = await import('@slack/bolt');
    const appInstance = vi.mocked(App).mock.results.at(-1)?.value;
    const messageHandler = appInstance.message.mock.calls[0]?.[0];
    await messageHandler?.({ message: { text: '!gate', user: 'U123', channel: 'C123' }, say });

    expect(onGateRun).toHaveBeenCalled();
    expect(say).toHaveBeenCalledWith(expect.stringMatching(/PASSED|FAILED/i));
  });

  it('reports the latest run on !gate status', async () => {
    const getLatestGateRun = vi.fn().mockReturnValue({ passed: false, results: [{ name: 'typecheck', status: 'failed', exitCode: 1, stdoutTail: '', stderrTail: 'e', required: true }] });
    const svc = new SlackService({
      config: makeConfig(),
      sessionManager: sessionManager as never,
      tmuxSocket: 'aisup-test',
      journal: journal as never,
      channelMapPath,
      getLatestGateRun,
    });
    await svc.start();

    const say = vi.fn();
    const { App } = await import('@slack/bolt');
    const appInstance = vi.mocked(App).mock.results.at(-1)?.value;
    const messageHandler = appInstance.message.mock.calls[0]?.[0];
    await messageHandler?.({ message: { text: '!gate status', user: 'U123', channel: 'C123' }, say });

    expect(getLatestGateRun).toHaveBeenCalled();
    expect(say).toHaveBeenCalledWith(expect.stringMatching(/FAILED/i));
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

  it('emits slack.channel_name_collision on an actual name_taken collision and retries with a suffix', async () => {
    const { App } = await import('@slack/bolt');
    const svc = new SlackService({
      config: makeConfig(),
      sessionManager: sessionManager as never,
      tmuxSocket: 'aisup-test',
      journal: journal as never,
      channelMapPath,
    });
    await svc.start();
    const appInstance = vi.mocked(App).mock.results.at(-1)?.value;
    // First create attempt collides (name_taken), second succeeds.
    appInstance.client.conversations.create
      .mockRejectedValueOnce({ data: { error: 'name_taken' } })
      .mockResolvedValueOnce({ channel: { id: 'C999' } });

    await svc.onSessionStart(makeSession({ aisup_session_id: 'sess-collide' }));

    expect(journal.append).toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'slack.channel_name_collision' })
    );
    expect(svc.getChannelId('sess-collide')).toBe('C999');
  });

  it('emits slack.rate_limited when the relay post is rate-limited', async () => {
    vi.useFakeTimers();
    const outputPath = join(tmpDir, 'output.log');
    writeFileSync(outputPath, 'seen\n');
    const session = makeSession({ output_log_path: outputPath });
    sessionManager.getActiveSession.mockReturnValue(session);

    const svc = new SlackService({
      config: makeConfig({ relay_output_enabled: true }),
      sessionManager: sessionManager as never,
      tmuxSocket: 'aisup-test',
      journal: journal as never,
      channelMapPath,
    });
    await svc.start();
    const { App } = await import('@slack/bolt');
    const appInstance = vi.mocked(App).mock.results.at(-1)?.value;
    appInstance.client.chat.postMessage.mockRejectedValueOnce({ code: 'slack_webapi_rate_limited_error', retryAfter: 30 });
    const internals = svc as unknown as { channelMap: Map<string, string>; relayEnabled: Map<string, boolean> };
    internals.channelMap.set(session.aisup_session_id, 'C123');
    internals.relayEnabled.set('C123', true);

    writeFileSync(outputPath, 'seen\nnew output line\n');
    await vi.advanceTimersByTimeAsync(10_000);

    expect(journal.append).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'slack.rate_limited',
        details: expect.objectContaining({ retry_after_s: 30 }),
      })
    );
    await svc.stop();
    vi.useRealTimers();
  });

  it('routes !stop through the canonical terminal stop path (session.stop + channel notification)', async () => {
    const svc = new SlackService({
      config: makeConfig(),
      sessionManager: sessionManager as never,
      tmuxSocket: 'aisup-test',
      journal: journal as never,
      channelMapPath,
    });
    await svc.start();
    const { App } = await import('@slack/bolt');
    const appInstance = vi.mocked(App).mock.results.at(-1)?.value;
    (svc as unknown as { channelMap: Map<string, string> }).channelMap.set('sess-001', 'C123');

    const messageHandler = appInstance.message.mock.calls[0]?.[0];
    const say = vi.fn();
    await messageHandler({ message: { text: '!stop', user: 'U123', channel: 'C123' }, say });
    await messageHandler({ message: { text: '!confirm', user: 'U123', channel: 'C123' }, say });

    expect(sessionManager.stopSession).toHaveBeenCalledWith('aisup-sess0001', 'sess-001', { force: false });
    expect(journal.append).toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'session.stop', aisup_session_id: 'sess-001' })
    );
    // Canonical stop notification posted to the channel.
    expect(appInstance.client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'C123', text: expect.stringContaining('ended') })
    );
  });

  it('relays new output-log diffs to the mapped channel when relay is enabled', async () => {
    vi.useFakeTimers();
    const outputPath = join(tmpDir, 'output.log');
    writeFileSync(outputPath, 'already seen\n');
    const session = makeSession({ output_log_path: outputPath });
    sessionManager.getActiveSession.mockReturnValue(session);

    const svc = new SlackService({
      config: makeConfig({ relay_output_enabled: true, redaction_patterns: ['SECRET=[^\\s]+'] }),
      sessionManager: sessionManager as never,
      tmuxSocket: 'aisup-test',
      journal: journal as never,
      channelMapPath,
    });
    await svc.start();
    const internals = svc as unknown as {
      channelMap: Map<string, string>;
      relayEnabled: Map<string, boolean>;
    };
    internals.channelMap.set(session.aisup_session_id, 'C123');
    internals.relayEnabled.set('C123', true);

    writeFileSync(outputPath, 'already seen\nnew SECRET=value line\n');
    await vi.advanceTimersByTimeAsync(10_000);

    const { App } = await import('@slack/bolt');
    const appInstance = vi.mocked(App).mock.results.at(-1)?.value;
    expect(appInstance.client.chat.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      channel: 'C123',
      text: expect.stringContaining('[REDACTED]'),
    }));
    await svc.stop();
    vi.useRealTimers();
  });

  // ---- Worker subcommands (Phase 3, MD-001) --------------------------------
  async function dispatch(svc: SlackService, text: string): Promise<ReturnType<typeof vi.fn>> {
    await svc.start();
    const say = vi.fn();
    const { App } = await import('@slack/bolt');
    const appInstance = vi.mocked(App).mock.results.at(-1)?.value;
    const messageHandler = appInstance.message.mock.calls[0]?.[0];
    await messageHandler?.({ message: { text, user: 'U123', channel: 'C123' }, say });
    return say;
  }

  // Bind a started service so multiple messages share one ConfirmationStore (request → !confirm).
  async function bind(svc: SlackService): Promise<(text: string, say: ReturnType<typeof vi.fn>) => Promise<void>> {
    await svc.start();
    const { App } = await import('@slack/bolt');
    const appInstance = vi.mocked(App).mock.results.at(-1)?.value;
    const messageHandler = appInstance.message.mock.calls[0]?.[0];
    return async (text, say) => {
      await messageHandler?.({ message: { text, user: 'U123', channel: 'C123' }, say });
    };
  }

  it('!worker approve <id> requires !confirm before invoking onWorkerApprove (ConfirmationStore)', async () => {
    const onWorkerApprove = vi.fn().mockResolvedValue({ ok: true });
    const svc = new SlackService({
      config: makeConfig(), sessionManager: sessionManager as never, tmuxSocket: 'aisup-test',
      journal: journal as never, channelMapPath, onWorkerApprove,
    });
    const send = await bind(svc);

    const say1 = vi.fn();
    await send('!worker approve abc-123', say1);
    expect(onWorkerApprove).not.toHaveBeenCalled(); // no merge without confirmation
    expect(say1).toHaveBeenCalledWith(expect.stringMatching(/!confirm/i));

    const say2 = vi.fn();
    await send('!confirm', say2);
    expect(onWorkerApprove).toHaveBeenCalledWith('abc-123');
    expect(say2).toHaveBeenCalledWith(expect.stringMatching(/approve ok/i));
  });

  it('!worker deny <id> requires !confirm, then reports no-op when the action did not apply', async () => {
    const onWorkerDeny = vi.fn().mockResolvedValue({ ok: false, reason: 'not_awaiting_approval' });
    const svc = new SlackService({
      config: makeConfig(), sessionManager: sessionManager as never, tmuxSocket: 'aisup-test',
      journal: journal as never, channelMapPath, onWorkerDeny,
    });
    const send = await bind(svc);

    const say1 = vi.fn();
    await send('!worker deny abc-123', say1);
    expect(onWorkerDeny).not.toHaveBeenCalled();
    expect(say1).toHaveBeenCalledWith(expect.stringMatching(/!confirm/i));

    const say2 = vi.fn();
    await send('!confirm', say2);
    expect(onWorkerDeny).toHaveBeenCalledWith('abc-123');
    expect(say2).toHaveBeenCalledWith(expect.stringMatching(/did not apply/i));
  });

  it('bare !deny still routes to the permission-denial command, not the worker surface (MD-001)', async () => {
    const onPermissionDeny = vi.fn().mockResolvedValue(true);
    const onWorkerDeny = vi.fn().mockResolvedValue({ ok: true });
    const svc = new SlackService({
      config: makeConfig(), sessionManager: sessionManager as never, tmuxSocket: 'aisup-test',
      journal: journal as never, channelMapPath, onPermissionDeny, onWorkerDeny,
    });
    const say = await dispatch(svc, '!deny');
    expect(onPermissionDeny).toHaveBeenCalledWith('sess-001');
    expect(onWorkerDeny).not.toHaveBeenCalled(); // worker surface untouched
    expect(say).toHaveBeenCalledWith(expect.stringMatching(/permission denied/i));
  });

  it('!worker status reports current worker states', async () => {
    const getWorkerStatus = vi.fn().mockReturnValue([
      { task: { id: 'w-1', title: 'do x' }, status: 'AWAITING_APPROVAL' },
    ]);
    const svc = new SlackService({
      config: makeConfig(), sessionManager: sessionManager as never, tmuxSocket: 'aisup-test',
      journal: journal as never, channelMapPath, getWorkerStatus,
    });
    const say = await dispatch(svc, '!worker status');
    expect(say).toHaveBeenCalledWith(expect.stringMatching(/w-1.*AWAITING_APPROVAL/s));
  });
});
