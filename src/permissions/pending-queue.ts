import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { PermissionRequest } from './types.js';

/**
 * Per-session FIFO queue of pending hook permission requests (AF-302). Two concurrent
 * `permission.ask` for the same session must both be tracked and resolved independently rather than
 * overwrite each other (the old `Map<sessionId, PermissionRequest>` kept only the latest, orphaning
 * the first dialog). Each `!permit`/`!deny` resolves the EARLIEST pending — matching the order
 * Claude stacks its terminal dialogs.
 *
 * A3: when constructed with a `persistPath`, the queue persists to disk (0600) on every mutation and
 * loads on construct, so a pending permission survives a daemon restart and the original Slack card
 * re-binds and resolves the same request with no operator re-send. There is NO timer here — a request
 * stays pending until a button tap, session stop (`clear`), or the dialog genuinely closing.
 */
export class PendingPermissionQueue {
  private queues = new Map<string, PermissionRequest[]>();

  constructor(private persistPath?: string) {
    this.load();
  }

  /** Append a pending request to the session's queue. */
  enqueue(sessionId: string, req: PermissionRequest): void {
    const q = this.queues.get(sessionId) ?? [];
    q.push(req);
    this.queues.set(sessionId, q);
    this.save();
  }

  /** Remove and return the earliest-pending request for the session, or null if none. */
  dequeue(sessionId: string): PermissionRequest | null {
    const q = this.queues.get(sessionId);
    if (!q || q.length === 0) return null;
    const req = q.shift()!;
    if (q.length === 0) this.queues.delete(sessionId);
    this.save();
    return req;
  }

  /**
   * Remove and return the pending request matching `requestId`, or null if none. Used by the
   * interactive Slack-button path so out-of-order taps resolve the exact request the card targets,
   * rather than the earliest-pending one (`dequeue` remains the FIFO fallback for id-less `!permit`).
   */
  resolveById(sessionId: string, requestId: string): PermissionRequest | null {
    const q = this.queues.get(sessionId);
    if (!q) return null;
    const idx = q.findIndex((r) => r.request_id === requestId);
    if (idx === -1) return null;
    const [req] = q.splice(idx, 1);
    if (q.length === 0) this.queues.delete(sessionId);
    this.save();
    return req;
  }

  /** Drop all pending requests for a session (e.g. on session stop). */
  clear(sessionId: string): void {
    if (this.queues.delete(sessionId)) this.save();
  }

  /** Number of pending requests for a session. */
  size(sessionId: string): number {
    return this.queues.get(sessionId)?.length ?? 0;
  }

  private load(): void {
    if (!this.persistPath || !existsSync(this.persistPath)) return;
    try {
      const raw = JSON.parse(readFileSync(this.persistPath, 'utf8')) as Record<string, PermissionRequest[]>;
      for (const [sessionId, list] of Object.entries(raw)) {
        if (Array.isArray(list) && list.length > 0) this.queues.set(sessionId, list);
      }
    } catch {
      // Corrupt store → start empty; the next mutation heals it.
    }
  }

  private save(): void {
    if (!this.persistPath) return;
    try {
      mkdirSync(dirname(this.persistPath), { recursive: true, mode: 0o700 });
      writeFileSync(this.persistPath, JSON.stringify(Object.fromEntries(this.queues), null, 2), { mode: 0o600 });
    } catch {
      // Best-effort persistence; an unwritable store must not crash permission handling.
    }
  }
}
