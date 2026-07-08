import { describe, it, expect, beforeEach } from 'vitest';
import {
  resolveHookPermissionViaKeystroke,
  sendPermissionKey,
  type HookResolverDeps,
} from '../../src/permissions/hook-resolver.js';
import { PendingPermissionQueue } from '../../src/permissions/pending-queue.js';
import type { SessionState, SessionStatus } from '../../src/session/types.js';
import type { JournalEvent } from '../../src/journal/types.js';

/**
 * Unit coverage for the unified hook keystroke resolver — the REAL Slack-button resolution path
 * (A0 extraction + A2 guard/id-routing). The resolver now (A2) re-scans `promptStillActive` before
 * injecting a keystroke (so a tap never lands in a closed/different prompt) and resolves by
 * `request_id` so out-of-order taps hit the correct request. A3 layers persistence on the same seam.
 */

function sessionState(status: SessionStatus): SessionState {
  return {
    aisup_session_id: 's1', status, account: 'acct', tmux_name: 'aisup-s1', tmux_session_id: null,
    pane_id: null, cwd: '/tmp', launch_started_at: new Date(0).toISOString(), claude_session_id: null,
    transcript_path: null, plan_path: null, active_skill: null, output_log_path: '/tmp/out.log',
    switch_tx: null, created_at: new Date(0).toISOString(), updated_at: new Date(0).toISOString(),
  };
}

function makeDeps(opts: { status?: SessionStatus | null; promptActive?: boolean } = {}): {
  deps: HookResolverDeps;
  queue: PendingPermissionQueue;
  sent: Array<{ tmuxName: string; key: string }>;
  events: JournalEvent[];
} {
  const status = opts.status === undefined ? 'ACTIVE' : opts.status;
  const queue = new PendingPermissionQueue();
  const sent: Array<{ tmuxName: string; key: string }> = [];
  const events: JournalEvent[] = [];
  const deps: HookResolverDeps = {
    queue,
    readState: () => (status === null ? null : sessionState(status)),
    sendKeystroke: (tmuxName, key) => sent.push({ tmuxName, key }),
    promptStillActive: () => opts.promptActive ?? true,
    permissions: { approval_key: 'y', denial_key: 'n' },
    journal: { append: async (e) => { events.push(e); } },
  };
  return { deps, queue, sent, events };
}

describe('hook permission resolver — extraction + FIFO', () => {
  let env: ReturnType<typeof makeDeps>;
  beforeEach(() => { env = makeDeps(); });

  it('returns false and sends nothing when no permission is pending', () => {
    expect(resolveHookPermissionViaKeystroke(env.deps, 's1', true)).toBe(false);
    expect(env.sent).toHaveLength(0);
  });

  it('dequeues FIFO and sends the approval key, journaling permission.granted', () => {
    env.queue.enqueue('s1', { tool: 'Bash', detail: 'git push', raw: 'r' });
    expect(resolveHookPermissionViaKeystroke(env.deps, 's1', true)).toBe(true);
    expect(env.sent).toEqual([{ tmuxName: 'aisup-s1', key: 'y' }]);
    expect(env.events.at(-1)?.event_type).toBe('permission.granted');
  });

  it('sends the denial key on deny, journaling permission.denied', () => {
    env.queue.enqueue('s1', { tool: 'Bash', detail: 'rm', raw: 'r' });
    expect(resolveHookPermissionViaKeystroke(env.deps, 's1', false)).toBe(true);
    expect(env.sent).toEqual([{ tmuxName: 'aisup-s1', key: 'n' }]);
    expect(env.events.at(-1)?.event_type).toBe('permission.denied');
  });

  it('does NOT send a keystroke when the session is not ACTIVE (keystroke_unconfirmed)', () => {
    const stopped = makeDeps({ status: 'STOPPED' });
    stopped.queue.enqueue('s1', { tool: 'Bash', detail: 'x', raw: 'r' });
    expect(resolveHookPermissionViaKeystroke(stopped.deps, 's1', true)).toBe(false);
    expect(stopped.sent).toHaveLength(0);
    expect(stopped.events.at(-1)?.event_type).toBe('permission.keystroke_unconfirmed');
  });

  it('sendPermissionKey allows SWITCH_PENDING_AT_IDLE as a live target', () => {
    const switching = makeDeps({ status: 'SWITCH_PENDING_AT_IDLE' });
    expect(sendPermissionKey(switching.deps, 's1', true)).toBe(true);
  });
});

describe('hook permission resolver — A2 promptStillActive guard', () => {
  it('does NOT inject a keystroke when the prompt is no longer active (closed dialog)', () => {
    const env = makeDeps({ promptActive: false });
    env.queue.enqueue('s1', { tool: 'Bash', detail: 'git push', raw: 'r', request_id: 'id-1' });
    const ok = resolveHookPermissionViaKeystroke(env.deps, 's1', true, 'id-1');
    expect(ok).toBe(false);
    expect(env.sent).toHaveLength(0); // the guard fired — no keystroke into a gone prompt
    expect(env.events.at(-1)?.event_type).toBe('permission.keystroke_unconfirmed');
  });

  it('sends the keystroke only after the prompt is confirmed still active', () => {
    const env = makeDeps({ promptActive: true });
    env.queue.enqueue('s1', { tool: 'Bash', detail: 'git push', raw: 'r', request_id: 'id-1' });
    expect(resolveHookPermissionViaKeystroke(env.deps, 's1', true, 'id-1')).toBe(true);
    expect(env.sent).toEqual([{ tmuxName: 'aisup-s1', key: 'y' }]);
  });
});

describe('hook permission resolver — A2 id-routing (not FIFO)', () => {
  it('resolves two concurrent cards by request_id when tapped out of order', () => {
    const env = makeDeps();
    env.queue.enqueue('s1', { tool: 'Bash', detail: 'first', raw: 'r', request_id: 'id-1' });
    env.queue.enqueue('s1', { tool: 'Edit', detail: 'second', raw: 'r', request_id: 'id-2' });

    // Tap the SECOND card first — must resolve 'second', not the FIFO-earliest 'first'.
    expect(resolveHookPermissionViaKeystroke(env.deps, 's1', true, 'id-2')).toBe(true);
    expect(env.events.at(-1)?.details).toMatchObject({ tool: 'Edit', detail: 'second' });
    expect(env.queue.size('s1')).toBe(1);

    expect(resolveHookPermissionViaKeystroke(env.deps, 's1', false, 'id-1')).toBe(true);
    expect(env.events.at(-1)?.details).toMatchObject({ tool: 'Bash', detail: 'first' });
  });

  it('falls back to FIFO dequeue when no request_id is given (legacy !permit)', () => {
    const env = makeDeps();
    env.queue.enqueue('s1', { tool: 'Bash', detail: 'first', raw: 'r', request_id: 'id-1' });
    expect(resolveHookPermissionViaKeystroke(env.deps, 's1', true)).toBe(true);
    expect(env.events.at(-1)?.details).toMatchObject({ detail: 'first' });
  });

  it('returns false when the request_id is unknown (no matching pending card)', () => {
    const env = makeDeps();
    env.queue.enqueue('s1', { tool: 'Bash', detail: 'first', raw: 'r', request_id: 'id-1' });
    expect(resolveHookPermissionViaKeystroke(env.deps, 's1', true, 'ghost')).toBe(false);
    expect(env.sent).toHaveLength(0);
  });
});
