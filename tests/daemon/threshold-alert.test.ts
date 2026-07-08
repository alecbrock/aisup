import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ThresholdAlerter, type ThresholdAlert } from '../../src/daemon/threshold-alert.js';

describe('ThresholdAlerter (A8 de-dup + warning band)', () => {
  let alerts: ThresholdAlert[];
  function make(warningPct?: number): ThresholdAlerter {
    alerts = [];
    return new ThresholdAlerter({ warningPct, notify: (a) => alerts.push(a) });
  }
  const tick = (al: ThresholdAlerter, level: 'none' | 'soft' | 'hard', five: number, seven = 0): void =>
    al.onResult({ account: 'primary', level, fiveHourPct: five, sevenDayPct: seven, resetEta: '2026-07-01T00:00:00Z' });

  it('pushes exactly one alert per upward band crossing, not per tick', () => {
    const al = make();
    tick(al, 'soft', 81);
    tick(al, 'soft', 82); // same band → no second alert
    tick(al, 'soft', 83);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ account: 'primary', band: 'soft' });
  });

  it('escalates soft → hard with a new alert', () => {
    const al = make();
    tick(al, 'soft', 82);
    tick(al, 'hard', 96);
    expect(alerts.map((a) => a.band)).toEqual(['soft', 'hard']);
  });

  it('emits a warning-band alert below soft when warning_pct is configured', () => {
    const al = make(60);
    tick(al, 'none', 62); // crosses warning (60) but below soft
    expect(alerts).toHaveLength(1);
    expect(alerts[0].band).toBe('warning');
  });

  it('does not emit a warning band when warning_pct is unset', () => {
    const al = make();
    tick(al, 'none', 62);
    expect(alerts).toHaveLength(0);
  });

  it('re-alerts after usage drops back below a band and crosses again', () => {
    const al = make();
    tick(al, 'soft', 82);     // alert
    tick(al, 'none', 10);     // reset (de-escalate, no alert)
    tick(al, 'soft', 83);     // crosses again → new alert
    expect(alerts.filter((a) => a.band === 'soft')).toHaveLength(2);
  });

  it('carries account + headroom + reset eta on the alert', () => {
    const al = make();
    tick(al, 'hard', 97, 90);
    expect(alerts[0]).toMatchObject({ account: 'primary', five_hour_pct: 97, seven_day_pct: 90, reset_eta: '2026-07-01T00:00:00Z' });
  });
});

// Service-level: alerts always post, even under !notify silent.
vi.mock('../../src/session/tmux.js', () => ({
  sendInterrupt: vi.fn(), sendEnter: vi.fn(), sendText: vi.fn(),
  captureOutput: vi.fn().mockReturnValue(''), isProcessDead: vi.fn().mockReturnValue(false),
  createTmuxSession: vi.fn(), destroyTmuxSession: vi.fn(), stopPipePane: vi.fn(),
  startOutputLog: vi.fn(), listSessions: vi.fn().mockReturnValue([]),
}));
const posted: Array<Record<string, unknown>> = [];
vi.mock('@slack/bolt', () => {
  const FakeApp = vi.fn().mockImplementation(() => ({
    message: vi.fn(), action: vi.fn(), view: vi.fn(),
    start: vi.fn().mockResolvedValue(undefined), stop: vi.fn().mockResolvedValue(undefined),
    client: { auth: { test: vi.fn().mockResolvedValue({ ok: true }) },
      chat: { postMessage: vi.fn().mockImplementation((a) => { posted.push(a); return Promise.resolve({ ts: 't' }); }) } },
  }));
  return { App: FakeApp };
});
import { SlackService } from '../../src/slack/service.js';
import type { SlackConfig } from '../../src/config/schema.js';

describe('SlackService.notifyThreshold (A8)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'aisup-thr-')); posted.length = 0; });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('posts a threshold alert even when the feed is silenced', async () => {
    const svc = new SlackService({
      config: { enabled: true, bot_token_env: 'B', app_token_env: 'A', allowed_user_ids: ['U1'],
        relay_output_enabled: false, cmd_require_confirmation: false, redaction_patterns: [], interactivity_enabled: true } as SlackConfig,
      sessionManager: { getActiveSession: () => null, stopSession: async () => {} },
      tmuxSocket: 'sock', journal: { append: async () => {} },
      channelMapPath: join(dir, 'channel-map.json'), cardStorePath: join(dir, 'slack-cards.json'),
      notificationsConfig: { verbosity: 'silent' },
    });
    await svc.start();
    (svc as unknown as { channelMap: Map<string, string> }).channelMap.set('s1', 'C1');
    (svc as unknown as { verbosityByChannel: Map<string, string> }).verbosityByChannel.set('C1', 'silent');

    await svc.notifyThreshold('s1', { account: 'primary', band: 'hard', five_hour_pct: 97, seven_day_pct: 80, reset_eta: '2026-07-01T00:00:00Z' });
    expect(posted).toHaveLength(1);
    expect(JSON.stringify(posted[0])).toContain('primary');
  });
});
