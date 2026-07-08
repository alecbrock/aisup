/**
 * @requires_tmux Host-gated A0 — verifies the never-timeout keystroke-resolution assumption that
 * ALL of Phase A rests on: a permission dialog left open for a long interval is still resolvable by
 * a keystroke sent through the REAL Slack-button path (`resolveHookPermissionViaKeystroke` →
 * real tmux send-keys), NOT only the legacy `PermissionBroker.resolveFromSlack`.
 *
 * Skipped unless AISUP_TEST_LONG_PERMISSION=1 (the always-run suite skips it). The pane runs a
 * Claude-shaped permission prompt that blocks indefinitely on `read` (no client-side timeout),
 * mirroring Claude's terminal dialog. The wait interval is parameterized:
 *   AISUP_TEST_LONG_PERMISSION=1 npx vitest run tests/permissions/long-permission.hostgated.test.ts
 *   AISUP_TEST_LONG_PERMISSION_WAIT_MS=360000 AISUP_TEST_LONG_PERMISSION=1 npx vitest run ...   # canonical ≥5 min
 *
 * Yields PASS or SKIP, never a harness ERROR. The Claude-specific dialog-persistence window and the
 * per-option keystroke mapping are recorded in docs/runbook.md from a real Claude observation; this
 * test proves the resolution MECHANISM (tmux pane + keystroke + resolver) never times out.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { sendText, sendEnter, captureOutput } from '../../src/session/tmux.js';
import { PermissionDetector } from '../../src/permissions/detector.js';
import { PendingPermissionQueue } from '../../src/permissions/pending-queue.js';
import { resolveHookPermissionViaKeystroke, type HookResolverDeps } from '../../src/permissions/hook-resolver.js';
import type { JournalEvent } from '../../src/journal/types.js';
import type { SessionState } from '../../src/session/types.js';

const SOCKET = 'aisup-longperm-test';
const enabled = process.env.AISUP_TEST_LONG_PERMISSION === '1';
const WAIT_MS = Number(process.env.AISUP_TEST_LONG_PERMISSION_WAIT_MS ?? 8000);

function hasTmux(): boolean {
  if (spawnSync('which', ['tmux']).status !== 0) return false;
  try {
    execFileSync('tmux', ['-L', SOCKET, 'new-session', '-d', '-s', 'probe', '/bin/sh'], { timeout: 5000 });
    execFileSync('tmux', ['-L', SOCKET, 'kill-session', '-t', 'probe'], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

function tmux(...args: string[]): void {
  execFileSync('tmux', ['-L', SOCKET, ...args], { timeout: 5000 });
}

async function waitFor(cond: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`waitFor timed out: ${label}`);
}

function activeState(tmuxName: string): SessionState {
  return {
    aisup_session_id: 'longperm',
    status: 'ACTIVE',
    account: 'acct',
    tmux_name: tmuxName,
    tmux_session_id: null,
    pane_id: null,
    cwd: '/tmp',
    launch_started_at: new Date(0).toISOString(),
    claude_session_id: null,
    transcript_path: null,
    plan_path: null,
    active_skill: null,
    output_log_path: '/tmp/out.log',
    switch_tx: null,
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
  };
}

const gate = enabled && hasTmux() ? describe : describe.skip;

gate('A0 never-timeout keystroke resolution (set AISUP_TEST_LONG_PERMISSION=1)', () => {
  let dir: string;
  const name = `longperm-${Date.now()}`;

  afterEach(() => {
    try { execFileSync('tmux', ['-L', SOCKET, 'kill-server']); } catch { /* none */ }
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it(`resolves a dialog left open ${WAIT_MS}ms via the real hook resolver`, async () => {
    dir = mkdtempSync(join(tmpdir(), 'aisup-longperm-'));
    const sentinel = join(dir, 'resolved');
    // A pane that prints a Claude-shaped permission prompt then blocks INDEFINITELY on read —
    // exactly the property A0 de-risks (no client-side timeout). On 'y' it writes RESOLVED.
    const script = `printf 'Allow Bash to run \\\`git status\\\`?\\n'; read REPLY; if [ "$REPLY" = "y" ]; then printf RESOLVED > '${sentinel}'; else printf DENIED > '${sentinel}'; fi; sleep 1`;
    tmux('new-session', '-d', '-s', name, '/bin/sh', '-c', script);

    const detector = new PermissionDetector([]);
    // The prompt is detectable once it renders.
    await waitFor(() => detector.scan(captureOutput(SOCKET, name)).length > 0, 5000, 'prompt rendered');

    const queue = new PendingPermissionQueue();
    queue.enqueue('longperm', { tool: 'Bash', detail: 'git status', raw: 'Allow Bash to run git status?' });

    const events: JournalEvent[] = [];
    const deps: HookResolverDeps = {
      queue,
      readState: () => activeState(name),
      sendKeystroke: (tmuxName, key) => { sendText(SOCKET, tmuxName, key); sendEnter(SOCKET, tmuxName); },
      // Real freshness re-scan of the live pane — the dialog must still be present to resolve (A2 guard).
      promptStillActive: () => new PermissionDetector([]).scan(captureOutput(SOCKET, name)).length > 0,
      permissions: { approval_key: 'y', denial_key: 'n' },
      journal: { append: async (e) => { events.push(e); } },
    };

    // Leave the dialog open for the configured interval. This is a deliberate time-persistence
    // assertion (not a flaky sleep): the point is that the dialog does NOT self-close.
    await new Promise((r) => setTimeout(r, WAIT_MS));

    // The dialog is STILL detectable at the wait boundary — it never timed out.
    const freshDetector = new PermissionDetector([]);
    expect(freshDetector.scan(captureOutput(SOCKET, name)).length).toBeGreaterThan(0);

    // Resolve via the REAL hook path. A keystroke sent hours later still answers the prompt.
    const ok = resolveHookPermissionViaKeystroke(deps, 'longperm', true);
    expect(ok).toBe(true);
    expect(events.at(-1)?.event_type).toBe('permission.granted');

    // The long-blocked prompt proceeded once the keystroke landed.
    await waitFor(() => existsSync(sentinel), 5000, 'prompt resolved');
    expect(readFileSync(sentinel, 'utf8')).toBe('RESOLVED');
  }, WAIT_MS + 60_000);
});
