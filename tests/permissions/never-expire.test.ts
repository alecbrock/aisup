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
const updated: Array<Record<string, unknown>> = [];
vi.mock('@slack/bolt', () => {
  const FakeApp = vi.fn().mockImplementation(() => ({
    message: vi.fn(), action: vi.fn(), view: vi.fn(),
    start: vi.fn().mockResolvedValue(undefined), stop: vi.fn().mockResolvedValue(undefined),
    client: {
      auth: { test: vi.fn().mockResolvedValue({ ok: true }) },
      chat: {
        postMessage: vi.fn().mockResolvedValue({ ts: '1.1' }),
        update: vi.fn().mockImplementation((a) => { updated.push(a); return Promise.resolve({}); }),
      },
    },
  }));
  return { App: FakeApp };
});

import { PendingPermissionQueue } from '../../src/permissions/pending-queue.js';
import { PermissionBroker, type PermissionBrokerDeps } from '../../src/permissions/broker.js';
import { resolveHookPermissionViaKeystroke, type HookResolverDeps } from '../../src/permissions/hook-resolver.js';
import { SlackService } from '../../src/slack/service.js';
import { PERM_ACTIONS } from '../../src/slack/blocks.js';
import type { PermissionsConfig, SlackConfig } from '../../src/config/schema.js';
import type { PermissionRequest } from '../../src/permissions/types.js';
import type { SessionState, SessionStatus } from '../../src/session/types.js';
import type { JournalEvent } from '../../src/journal/types.js';

const req: PermissionRequest = { tool: 'Bash', detail: 'git status', raw: 'r', request_id: 'rq-1' };

function permissions(over: Partial<PermissionsConfig> = {}): PermissionsConfig {
  return {
    enabled: true, detection_patterns: [], approval_key: 'y', denial_key: 'n',
    policy: { allowlist: [], denylist: [], default_action: 'deny' }, slack_routing: true,
    grant_ttl_seconds: 300, ...over,
  };
}

describe('A3 fallback broker TTL sentinel (never-expire by default)', () => {
  let journal: { append: ReturnType<typeof vi.fn> };
  let sendKeystroke: ReturnType<typeof vi.fn>;
  let clock: number;
  const build = (perm: PermissionsConfig): PermissionBroker => {
    const deps: PermissionBrokerDeps = {
      permissions: perm, journal: journal as never, sendKeystroke,
      promptStillActive: () => true, routeToSlack: vi.fn(), now: () => clock,
    };
    return new PermissionBroker(deps);
  };
  const events = (): string[] => journal.append.mock.calls.map((c) => (c[0] as { event_type: string }).event_type);
  beforeEach(() => { journal = { append: vi.fn().mockResolvedValue(undefined) }; sendKeystroke = vi.fn().mockReturnValue(true); clock = 1_000_000; });

  it('grant_ttl_seconds: null never expires even after a long wait', async () => {
    const broker = build(permissions({ grant_ttl_seconds: null as unknown as number }));
    await broker.onDetected('s1', req);
    clock += 10 * 60 * 60 * 1000; // +10 hours
    expect(await broker.resolveFromSlack('s1', 'grant')).toBe(true);
    expect(events()).not.toContain('permission.keystroke_timeout');
  });

  it('grant_ttl_seconds: 0 never expires (0 is NOT an immediate-timeout sentinel)', async () => {
    const broker = build(permissions({ grant_ttl_seconds: 0 }));
    await broker.onDetected('s1', req);
    clock += 60_000;
    expect(await broker.resolveFromSlack('s1', 'grant')).toBe(true);
    expect(events()).not.toContain('permission.keystroke_timeout');
  });

  it('a finite grant_ttl_seconds > 0 still expires after the window', async () => {
    const broker = build(permissions({ grant_ttl_seconds: 5 }));
    await broker.onDetected('s1', req);
    clock += 6_000; // past the 5s window
    expect(await broker.resolveFromSlack('s1', 'grant')).toBe(false);
    expect(events()).toContain('permission.keystroke_timeout');
  });
});

describe('A3 hook queue persistence', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'aisup-pq-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('round-trips pending requests through disk (resolvable after a restart)', () => {
    const path = join(dir, 'pending-permissions.json');
    const q1 = new PendingPermissionQueue(path);
    q1.enqueue('s1', { tool: 'Bash', detail: 'git push', raw: 'r', request_id: 'rq-9' });
    // "Restart": a fresh queue from the same path still has the pending request.
    const q2 = new PendingPermissionQueue(path);
    expect(q2.size('s1')).toBe(1);
    expect(q2.resolveById('s1', 'rq-9')?.detail).toBe('git push');
    // Resolution persists too — a third instance sees it gone.
    expect(new PendingPermissionQueue(path).size('s1')).toBe(0);
  });

  it('the hook path has no timer — a long-pending request is still resolvable', () => {
    const path = join(dir, 'pending-permissions.json');
    const q = new PendingPermissionQueue(path);
    q.enqueue('s1', { tool: 'Bash', detail: 'x', raw: 'r', request_id: 'rq-1' });
    const sent: string[] = [];
    const deps: HookResolverDeps = {
      queue: q,
      readState: () => activeState('aisup-s1'),
      sendKeystroke: (_n, key) => sent.push(key),
      promptStillActive: () => true,
      permissions: { approval_key: 'y', denial_key: 'n' },
      journal: { append: async () => {} },
    };
    expect(resolveHookPermissionViaKeystroke(deps, 's1', true, 'rq-1')).toBe(true);
    expect(sent).toEqual(['y']);
  });
});

function activeState(tmuxName: string, status: SessionStatus = 'ACTIVE'): SessionState {
  return {
    aisup_session_id: 's1', status, account: 'a', tmux_name: tmuxName, tmux_session_id: null, pane_id: null,
    cwd: '/tmp', launch_started_at: new Date(0).toISOString(), claude_session_id: null, transcript_path: null,
    plan_path: null, active_skill: null, output_log_path: '/tmp/o.log', switch_tx: null,
    created_at: new Date(0).toISOString(), updated_at: new Date(0).toISOString(),
  };
}

describe('A3 restart re-bind of pending permission cards', () => {
  let dir: string;
  let events: JournalEvent[];
  function slackConfig(): SlackConfig {
    return { enabled: true, bot_token_env: 'AISUP_SLACK_BOT_TOKEN', app_token_env: 'AISUP_SLACK_APP_TOKEN',
      allowed_user_ids: ['U1'], relay_output_enabled: false, cmd_require_confirmation: false,
      redaction_patterns: [], interactivity_enabled: true };
  }
  function makeService(queue: PendingPermissionQueue, grants: string[]): SlackService {
    const hookDeps: HookResolverDeps = {
      queue, readState: () => activeState('aisup-s1'), sendKeystroke: () => {},
      promptStillActive: () => true, permissions: { approval_key: 'y', denial_key: 'n' },
      journal: { append: async () => {} },
    };
    return new SlackService({
      config: slackConfig(),
      sessionManager: { getActiveSession: () => null, stopSession: async () => {} },
      tmuxSocket: 'sock',
      journal: { append: async (e) => { events.push(e); } },
      channelMapPath: join(dir, 'channel-map.json'),
      cardStorePath: join(dir, 'slack-cards.json'),
      permissionsConfig: permissions(),
      onPermissionGrant: (sessionId, requestId) => {
        const ok = resolveHookPermissionViaKeystroke(hookDeps, sessionId, true, requestId);
        if (ok) grants.push(requestId ?? 'fifo');
        return ok;
      },
    });
  }
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'aisup-rebind-')); events = []; updated.length = 0; });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('a live session re-binds; tapping the original card resolves with no operator re-send', async () => {
    const qPath = join(dir, 'pending-permissions.json');
    // Pre-restart: enqueue + register the card.
    const q1 = new PendingPermissionQueue(qPath);
    q1.enqueue('s1', { tool: 'Bash', detail: 'git push', raw: 'r', request_id: 'rq-7' });
    const pre = makeService(q1, []);
    await pre.start();
    pre.registerCard({ request_id: 'rq-7', channel: 'C1', message_ts: '1.1', kind: 'permission', session_id: 's1', payload: { tool: 'Bash', detail: 'git push' } });

    // "Restart": fresh queue + service from the same persisted paths.
    const grants: string[] = [];
    const q2 = new PendingPermissionQueue(qPath);
    const post = makeService(q2, grants);
    await post.start();
    const recon = await post.reconcilePendingPermissions(() => true);
    expect(recon.rebound).toBe(1);

    // Tapping the original card resolves the still-pending request — no re-send.
    await post.handleAction({ type: 'block_actions', user: { id: 'U1' },
      actions: [{ action_id: PERM_ACTIONS.approve, value: 'rq-7' }], channel: { id: 'C1' }, message: { ts: '1.1' } },
      vi.fn().mockResolvedValue(undefined));
    expect(grants).toEqual(['rq-7']);
    expect(q2.size('s1')).toBe(0);
  });

  it('a dead session annotates the card and drops it (never silently dropped)', async () => {
    const q = new PendingPermissionQueue(join(dir, 'pending-permissions.json'));
    const svc = makeService(q, []);
    await svc.start();
    svc.registerCard({ request_id: 'rq-dead', channel: 'C1', message_ts: '1.1', kind: 'permission', session_id: 'gone', payload: { tool: 'Bash', detail: 'x' } });
    const recon = await svc.reconcilePendingPermissions(() => false);
    expect(recon.stale).toBe(1);
    expect(JSON.stringify(updated.at(-1))).toMatch(/no longer|stale|ended/i);
    expect(svc.getCard('rq-dead')).toBeNull();
  });
});
