import type { PermissionsConfig } from '../config/schema.js';
import type { JournalEvent } from '../journal/types.js';
import type { SessionState } from '../session/types.js';
import type { PendingPermissionQueue } from './pending-queue.js';

/**
 * Dependencies for the hook keystroke resolver — the REAL Slack-button permission path.
 * A button tap (`onPermissionGrant`/`onPermissionDeny`) flows through here, NOT the legacy
 * `PermissionBroker.resolveFromSlack` (that is only the fallback when the hook queue is empty).
 * Extracted from the daemon closure so the host-gated never-timeout test (A0) and the always-run
 * unit suite drive the exact production resolution code, and so A2 can layer the unified
 * `promptStillActive` guard + id-routing onto a single seam.
 */
export interface HookResolverDeps {
  /** Per-session FIFO queue of pending hook permission requests. */
  queue: PendingPermissionQueue;
  /** Current persisted state for a session (live status + tmux target). */
  readState: (aisupSessionId: string) => SessionState | null;
  /** Send `key` then Enter to the named tmux pane (the persistent permission dialog). */
  sendKeystroke: (tmuxName: string, key: string) => void;
  /** Re-scan recent pane output; true when a permission prompt is still showing. A2 guard: a button
   *  tap must NEVER inject a keystroke into a closed/different prompt (the hole the broker fallback
   *  already guarded against; the hook path now does too). */
  promptStillActive: (aisupSessionId: string) => boolean;
  permissions: Pick<PermissionsConfig, 'approval_key' | 'denial_key'>;
  journal: { append: (event: JournalEvent) => Promise<void> };
}

/**
 * Send the approve/deny keystroke to the session's persistent permission dialog. Returns false
 * (sending nothing) when the session has no live, keystroke-able target — the dialog only exists
 * while the runner is ACTIVE (or holding at idle for a pending switch).
 */
export function sendPermissionKey(deps: HookResolverDeps, aisupSessionId: string, approve: boolean): boolean {
  const s = deps.readState(aisupSessionId);
  if (!s || (s.status !== 'ACTIVE' && s.status !== 'SWITCH_PENDING_AT_IDLE')) return false;
  // A2 guard (must-fix): confirm the dialog is still open before touching the pane, so a tap on a
  // closed/already-resolved prompt never injects a stray keystroke into whatever is on screen now.
  if (!deps.promptStillActive(aisupSessionId)) return false;
  deps.sendKeystroke(s.tmux_name, approve ? deps.permissions.approval_key : deps.permissions.denial_key);
  return true;
}

/**
 * Resolve the earliest-pending hook permission for a session via a keystroke to the persistent
 * dialog. This path has NO timer — a request stays resolvable for as long as the dialog is open
 * (minutes or hours later), which is what makes "permission prompts never time out" true. Emits
 * `permission.granted`/`permission.denied` only when the keystroke was actually sent, else
 * `permission.keystroke_unconfirmed`.
 */
export function resolveHookPermissionViaKeystroke(
  deps: HookResolverDeps,
  aisupSessionId: string,
  approve: boolean,
  requestId?: string
): boolean {
  // Id-routing (A2): a button carries its request_id, so resolve that exact request even when an
  // earlier card is still pending. `dequeue` (FIFO) remains the fallback for the id-less `!permit`.
  const pending = requestId
    ? deps.queue.resolveById(aisupSessionId, requestId)
    : deps.queue.dequeue(aisupSessionId);
  if (!pending) return false;
  const sent = sendPermissionKey(deps, aisupSessionId, approve);
  void deps.journal.append({
    ts: new Date().toISOString(),
    event_type: sent ? (approve ? 'permission.granted' : 'permission.denied') : 'permission.keystroke_unconfirmed',
    aisup_session_id: aisupSessionId,
    details: { tool: pending.tool, detail: pending.detail, source: 'hook' },
  });
  return sent;
}
