import { evaluatePermission } from './policy.js';
import type { PermissionsConfig } from '../config/schema.js';
import type { JournalWriter, EventType } from '../journal/types.js';
import type { PermissionRequest } from './types.js';

export interface PermissionBrokerDeps {
  permissions: PermissionsConfig;
  journal: JournalWriter;
  /** Send `key` followed by Enter to the session's pane. Returns false when there is no live target. */
  sendKeystroke: (sessionId: string, key: string) => boolean;
  /** Re-scan recent output; true when a permission prompt is still showing. */
  promptStillActive: (sessionId: string) => boolean;
  /** Post the prompt to Slack for a human decision (provided only when Slack is enabled). */
  routeToSlack?: (sessionId: string, request: PermissionRequest) => void;
  /** Clock injection for deterministic TTL handling. */
  now?: () => number;
}

interface PendingPermission {
  request: PermissionRequest;
  detectedAt: number;
}

/**
 * Routes detected permission prompts to an action. Pure policy (allow/deny/ask) is decided by
 * `evaluatePermission`; this broker owns the side effects: auto-grant/deny via tmux keystroke,
 * or route-to-Slack for human decision. A keystroke is sent only after a freshness re-scan
 * confirms the prompt is still active, and the grant/deny event is emitted only after the
 * keystroke is sent. Slack-routed requests expire after `grant_ttl_seconds`.
 */
export class PermissionBroker {
  private pending = new Map<string, PendingPermission>();

  constructor(private deps: PermissionBrokerDeps) {}

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  /** Decide and act on a freshly-detected permission request. */
  async onDetected(sessionId: string, request: PermissionRequest): Promise<void> {
    const decision = evaluatePermission(request, this.deps.permissions.policy);
    if (decision === 'grant') return this.act(sessionId, request, 'grant', 'auto');
    if (decision === 'deny') return this.act(sessionId, request, 'deny', 'auto');

    // 'ask' → route to a human when Slack is configured; otherwise auto-deny (safe default).
    if (this.deps.permissions.slack_routing && this.deps.routeToSlack) {
      this.pending.set(sessionId, { request, detectedAt: this.now() });
      this.deps.routeToSlack(sessionId, request);
      await this.emit('permission.routed_to_slack', sessionId, request);
      return;
    }
    return this.act(sessionId, request, 'deny', 'auto');
  }

  /** Resolve a Slack-routed request via `!permit` / `!deny`. Returns true when acted on. */
  async resolveFromSlack(sessionId: string, action: 'grant' | 'deny'): Promise<boolean> {
    const pend = this.pending.get(sessionId);
    if (!pend) return false;
    this.pending.delete(sessionId);

    const ttlMs = this.deps.permissions.grant_ttl_seconds * 1000;
    if (this.now() - pend.detectedAt > ttlMs) {
      await this.emit('permission.keystroke_timeout', sessionId, pend.request);
      return false;
    }
    await this.act(sessionId, pend.request, action, 'manual');
    return true;
  }

  private async act(
    sessionId: string,
    request: PermissionRequest,
    action: 'grant' | 'deny',
    mode: 'auto' | 'manual'
  ): Promise<void> {
    // Re-scan to confirm the prompt is still active before touching the pane. The grant/deny
    // event is never emitted unless the keystroke is actually sent.
    if (!this.deps.promptStillActive(sessionId)) {
      await this.emit('permission.keystroke_unconfirmed', sessionId, request);
      return;
    }
    const key = action === 'grant' ? this.deps.permissions.approval_key : this.deps.permissions.denial_key;
    if (!this.deps.sendKeystroke(sessionId, key)) {
      await this.emit('permission.keystroke_unconfirmed', sessionId, request);
      return;
    }
    const event: EventType = action === 'grant'
      ? (mode === 'auto' ? 'permission.auto_granted' : 'permission.granted')
      : (mode === 'auto' ? 'permission.auto_denied' : 'permission.denied');
    await this.emit(event, sessionId, request);
  }

  private emit(event: EventType, sessionId: string, request: PermissionRequest): Promise<void> {
    return this.deps.journal.append({
      ts: new Date().toISOString(),
      event_type: event,
      aisup_session_id: sessionId,
      details: { tool: request.tool, detail: request.detail },
    });
  }
}
