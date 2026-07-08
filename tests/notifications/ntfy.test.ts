import { describe, it, expect, vi } from 'vitest';
import { createNtfyEmitter } from '../../src/notifications/ntfy.js';
import type { NtfyConfig } from '../../src/config/schema.js';
import type { JournalEvent, JournalWriter } from '../../src/journal/types.js';

function spyJournal(): { journal: JournalWriter; events: JournalEvent[] } {
  const events: JournalEvent[] = [];
  return { events, journal: { append: async (e) => { events.push(e); } } };
}

const enabled: NtfyConfig = { enabled: true, topic: 'aisup-alerts', server: 'https://ntfy.sh' };

describe('D2: ntfy emitter', () => {
  it('POSTs the event to <server>/<topic> with title/priority headers when enabled', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('', { status: 200 }));
    const { journal, events } = spyJournal();
    const emit = createNtfyEmitter({ config: enabled, journal, fetchImpl: fetchImpl as unknown as typeof fetch });

    await emit({ title: 'Session exhausted', message: 'No account left', priority: 'high', tags: ['warning'] });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://ntfy.sh/aisup-alerts');
    expect(init.method).toBe('POST');
    expect(init.headers.Title).toBe('Session exhausted');
    expect(init.headers.Priority).toBe('high');
    expect(init.headers.Tags).toBe('warning');
    expect(init.body).toBe('No account left');
    expect(events).toHaveLength(0); // success → no failure journaled
  });

  it('does NOT POST when disabled or unconfigured', async () => {
    const fetchImpl = vi.fn();
    const { journal } = spyJournal();
    const off = createNtfyEmitter({ config: { ...enabled, enabled: false }, journal, fetchImpl: fetchImpl as unknown as typeof fetch });
    await off({ title: 't', message: 'm' });
    const noTopic = createNtfyEmitter({ config: { ...enabled, topic: '' }, journal, fetchImpl: fetchImpl as unknown as typeof fetch });
    await noTopic({ title: 't', message: 'm' });
    const absent = createNtfyEmitter({ config: undefined, journal, fetchImpl: fetchImpl as unknown as typeof fetch });
    await absent({ title: 't', message: 'm' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('journals (and does not throw) when the POST rejects or errors', async () => {
    const { journal, events } = spyJournal();
    const throwing = createNtfyEmitter({ config: enabled, journal, fetchImpl: (() => Promise.reject(new Error('network down'))) as unknown as typeof fetch });
    await expect(throwing({ title: 't', message: 'm' })).resolves.toBeUndefined();

    const bad = createNtfyEmitter({ config: enabled, journal, fetchImpl: (() => Promise.resolve(new Response('', { status: 500 }))) as unknown as typeof fetch });
    await bad({ title: 't', message: 'm' });

    expect(events.map((e) => e.event_type)).toEqual(['notification.ntfy_failed', 'notification.ntfy_failed']);
    expect(events[0].details.reason).toMatch(/network down/);
    expect(events[1].details.reason).toMatch(/500/);
  });
});
