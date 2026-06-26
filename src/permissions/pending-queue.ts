import type { PermissionRequest } from './types.js';

/**
 * Per-session FIFO queue of pending hook permission requests (AF-302). Two concurrent
 * `permission.ask` for the same session must both be tracked and resolved independently rather than
 * overwrite each other (the old `Map<sessionId, PermissionRequest>` kept only the latest, orphaning
 * the first dialog). Each `!permit`/`!deny` resolves the EARLIEST pending — matching the order
 * Claude stacks its terminal dialogs.
 */
export class PendingPermissionQueue {
  private queues = new Map<string, PermissionRequest[]>();

  /** Append a pending request to the session's queue. */
  enqueue(sessionId: string, req: PermissionRequest): void {
    const q = this.queues.get(sessionId) ?? [];
    q.push(req);
    this.queues.set(sessionId, q);
  }

  /** Remove and return the earliest-pending request for the session, or null if none. */
  dequeue(sessionId: string): PermissionRequest | null {
    const q = this.queues.get(sessionId);
    if (!q || q.length === 0) return null;
    const req = q.shift()!;
    if (q.length === 0) this.queues.delete(sessionId);
    return req;
  }

  /** Drop all pending requests for a session (e.g. on session stop). */
  clear(sessionId: string): void {
    this.queues.delete(sessionId);
  }

  /** Number of pending requests for a session. */
  size(sessionId: string): number {
    return this.queues.get(sessionId)?.length ?? 0;
  }
}
