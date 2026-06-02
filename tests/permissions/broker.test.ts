import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PermissionBroker, type PermissionBrokerDeps } from '../../src/permissions/broker.js';
import type { PermissionsConfig } from '../../src/config/schema.js';
import type { PermissionRequest } from '../../src/permissions/types.js';

const req: PermissionRequest = { tool: 'Bash', detail: 'git status', raw: 'Bash: git status' };

function permissions(over: Partial<PermissionsConfig> = {}): PermissionsConfig {
  return {
    enabled: true,
    detection_patterns: [],
    approval_key: 'y',
    denial_key: 'n',
    policy: { allowlist: [], denylist: [], default_action: 'deny' },
    slack_routing: false,
    grant_ttl_seconds: 300,
    ...over,
  };
}

describe('PermissionBroker', () => {
  let journal: { append: ReturnType<typeof vi.fn> };
  let sendKeystroke: ReturnType<typeof vi.fn>;
  let promptStillActive: ReturnType<typeof vi.fn>;
  let routeToSlack: ReturnType<typeof vi.fn>;
  let clock: number;

  const build = (perm: PermissionsConfig): PermissionBroker => {
    const deps: PermissionBrokerDeps = {
      permissions: perm,
      journal: journal as never,
      sendKeystroke,
      promptStillActive,
      routeToSlack,
      now: () => clock,
    };
    return new PermissionBroker(deps);
  };

  const eventTypes = (): string[] =>
    journal.append.mock.calls.map((c) => (c[0] as { event_type: string }).event_type);

  beforeEach(() => {
    journal = { append: vi.fn().mockResolvedValue(undefined) };
    sendKeystroke = vi.fn().mockReturnValue(true);
    promptStillActive = vi.fn().mockReturnValue(true);
    routeToSlack = vi.fn();
    clock = 1_000_000;
  });

  it('auto-grants an allowlisted request: approval key + auto_granted', async () => {
    const broker = build(permissions({ policy: { allowlist: ['Bash:git *'], denylist: [], default_action: 'deny' } }));
    await broker.onDetected('s1', req);
    expect(sendKeystroke).toHaveBeenCalledWith('s1', 'y');
    expect(eventTypes()).toContain('permission.auto_granted');
  });

  it('auto-denies a denylisted request: denial key + auto_denied', async () => {
    const broker = build(permissions({ policy: { allowlist: [], denylist: ['Bash:*'], default_action: 'deny' } }));
    await broker.onDetected('s1', req);
    expect(sendKeystroke).toHaveBeenCalledWith('s1', 'n');
    expect(eventTypes()).toContain('permission.auto_denied');
  });

  it('routes an unmatched request to Slack when slack_routing is enabled', async () => {
    const broker = build(permissions({ slack_routing: true }));
    await broker.onDetected('s1', req);
    expect(routeToSlack).toHaveBeenCalledWith('s1', req);
    expect(sendKeystroke).not.toHaveBeenCalled();
    expect(eventTypes()).toContain('permission.routed_to_slack');
  });

  it('auto-denies an unmatched request when slack_routing is disabled (no human in the loop)', async () => {
    const broker = build(permissions({ slack_routing: false }));
    await broker.onDetected('s1', req);
    expect(sendKeystroke).toHaveBeenCalledWith('s1', 'n');
    expect(eventTypes()).toContain('permission.auto_denied');
  });

  it('does not send a keystroke and emits keystroke_unconfirmed when the prompt is stale', async () => {
    promptStillActive.mockReturnValue(false);
    const broker = build(permissions({ policy: { allowlist: ['Bash:*'], denylist: [], default_action: 'deny' } }));
    await broker.onDetected('s1', req);
    expect(sendKeystroke).not.toHaveBeenCalled();
    expect(eventTypes()).toContain('permission.keystroke_unconfirmed');
    expect(eventTypes()).not.toContain('permission.auto_granted');
  });

  it('grants from Slack !permit: approval key + permission.granted', async () => {
    const broker = build(permissions({ slack_routing: true }));
    await broker.onDetected('s1', req); // pending
    const ok = await broker.resolveFromSlack('s1', 'grant');
    expect(ok).toBe(true);
    expect(sendKeystroke).toHaveBeenCalledWith('s1', 'y');
    expect(eventTypes()).toContain('permission.granted');
  });

  it('denies from Slack !deny: denial key + permission.denied', async () => {
    const broker = build(permissions({ slack_routing: true }));
    await broker.onDetected('s1', req);
    await broker.resolveFromSlack('s1', 'deny');
    expect(sendKeystroke).toHaveBeenCalledWith('s1', 'n');
    expect(eventTypes()).toContain('permission.denied');
  });

  it('emits keystroke_timeout and sends nothing when the pending request expires past TTL', async () => {
    const broker = build(permissions({ slack_routing: true, grant_ttl_seconds: 60 }));
    await broker.onDetected('s1', req); // detected at clock
    clock += 61_000; // past 60s TTL
    const ok = await broker.resolveFromSlack('s1', 'grant');
    expect(ok).toBe(false);
    expect(sendKeystroke).not.toHaveBeenCalled();
    expect(eventTypes()).toContain('permission.keystroke_timeout');
  });

  it('returns false from resolveFromSlack when nothing is pending', async () => {
    const broker = build(permissions({ slack_routing: true }));
    expect(await broker.resolveFromSlack('s1', 'grant')).toBe(false);
    expect(sendKeystroke).not.toHaveBeenCalled();
  });
});
