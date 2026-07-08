import { describe, it, expect } from 'vitest';
import { PendingPermissionQueue } from '../../src/permissions/pending-queue.js';
import type { PermissionRequest } from '../../src/permissions/types.js';

const req = (detail: string): PermissionRequest => ({ tool: 'Bash', detail, raw: `Bash: ${detail}` });

describe('PendingPermissionQueue (AF-302)', () => {
  it('resolves two concurrent prompts for one session independently, earliest-first', () => {
    const q = new PendingPermissionQueue();
    const s = 'aisup-abc12345';

    q.enqueue(s, req('first'));
    q.enqueue(s, req('second'));
    expect(q.size(s)).toBe(2);

    // Earliest-pending resolves first (FIFO) — neither overwrites the other.
    expect(q.dequeue(s)?.detail).toBe('first');
    expect(q.dequeue(s)?.detail).toBe('second');
    expect(q.dequeue(s)).toBeNull();
    expect(q.size(s)).toBe(0);
  });

  it('keeps per-session queues isolated', () => {
    const q = new PendingPermissionQueue();
    q.enqueue('s1', req('a'));
    q.enqueue('s2', req('b'));
    expect(q.dequeue('s1')?.detail).toBe('a');
    expect(q.dequeue('s1')).toBeNull();
    expect(q.dequeue('s2')?.detail).toBe('b');
  });

  it('clear() drops all pending for a session', () => {
    const q = new PendingPermissionQueue();
    q.enqueue('s', req('a'));
    q.enqueue('s', req('b'));
    q.clear('s');
    expect(q.size('s')).toBe(0);
    expect(q.dequeue('s')).toBeNull();
  });

  it('dequeue on an empty/unknown session returns null', () => {
    const q = new PendingPermissionQueue();
    expect(q.dequeue('nope')).toBeNull();
  });

  it('resolveById removes the matching entry regardless of FIFO order (out-of-order taps)', () => {
    const q = new PendingPermissionQueue();
    const s = 'aisup-abc12345';
    q.enqueue(s, { tool: 'Bash', detail: 'first', raw: 'r', request_id: 'id-1' });
    q.enqueue(s, { tool: 'Edit', detail: 'second', raw: 'r', request_id: 'id-2' });

    // Resolve the SECOND card first — id-routing, not FIFO.
    expect(q.resolveById(s, 'id-2')?.detail).toBe('second');
    expect(q.size(s)).toBe(1);
    // The first is still pending and resolvable.
    expect(q.resolveById(s, 'id-1')?.detail).toBe('first');
    expect(q.size(s)).toBe(0);
  });

  it('resolveById returns null for an unknown id (no entry removed)', () => {
    const q = new PendingPermissionQueue();
    q.enqueue('s', { tool: 'Bash', detail: 'a', raw: 'r', request_id: 'id-1' });
    expect(q.resolveById('s', 'ghost')).toBeNull();
    expect(q.size('s')).toBe(1);
  });
});
