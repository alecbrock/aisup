import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readEvents } from '../../src/journal/reader.js';
import type { JournalEvent } from '../../src/journal/types.js';

function makeEvent(overrides: Partial<JournalEvent> = {}): JournalEvent {
  return {
    ts: new Date().toISOString(),
    event_type: 'daemon.started',
    details: {},
    ...overrides,
  };
}

function writeJournal(path: string, events: JournalEvent[]): void {
  const content = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
  writeFileSync(path, content);
}

describe('readEvents', () => {
  let tmpDir: string;
  let journalPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'aisup-reader-'));
    journalPath = join(tmpDir, 'journal.jsonl');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should return all events when no filters applied', async () => {
    const events: JournalEvent[] = [
      makeEvent({ event_type: 'daemon.started', ts: '2026-01-01T00:00:00.000Z' }),
      makeEvent({ event_type: 'daemon.ready', ts: '2026-01-01T00:00:01.000Z' }),
      makeEvent({ event_type: 'session.start', ts: '2026-01-01T00:00:02.000Z' }),
    ];
    writeJournal(journalPath, events);

    const result = await readEvents(journalPath, {});
    expect(result).toHaveLength(3);
    expect(result[0].event_type).toBe('daemon.started');
    expect(result[2].event_type).toBe('session.start');
  });

  it('should filter by event type', async () => {
    const events: JournalEvent[] = [
      makeEvent({ event_type: 'daemon.started' }),
      makeEvent({ event_type: 'session.start' }),
      makeEvent({ event_type: 'session.stop' }),
    ];
    writeJournal(journalPath, events);

    const result = await readEvents(journalPath, { type: 'session.start' });
    expect(result).toHaveLength(1);
    expect(result[0].event_type).toBe('session.start');
  });

  it('should filter by since timestamp', async () => {
    const events: JournalEvent[] = [
      makeEvent({ ts: '2026-01-01T00:00:00.000Z' }),
      makeEvent({ ts: '2026-01-01T01:00:00.000Z' }),
      makeEvent({ ts: '2026-01-01T02:00:00.000Z' }),
    ];
    writeJournal(journalPath, events);

    const result = await readEvents(journalPath, { since: '2026-01-01T01:00:00.000Z' });
    expect(result).toHaveLength(2);
    expect(result[0].ts).toBe('2026-01-01T01:00:00.000Z');
  });

  it('should respect limit option', async () => {
    const events = Array.from({ length: 10 }, (_, i) =>
      makeEvent({ ts: `2026-01-01T00:00:0${i}.000Z` })
    );
    writeJournal(journalPath, events);

    const result = await readEvents(journalPath, { limit: 3 });
    expect(result).toHaveLength(3);
    // limit returns last N events
    expect(result[0].ts).toBe('2026-01-01T00:00:07.000Z');
    expect(result[2].ts).toBe('2026-01-01T00:00:09.000Z');
  });

  it('should return empty array for non-existent file', async () => {
    const result = await readEvents(join(tmpDir, 'missing.jsonl'), {});
    expect(result).toEqual([]);
  });

  it('should skip partial last line gracefully', async () => {
    const event = makeEvent({ event_type: 'daemon.started' });
    // Write a valid line + partial line (simulating in-progress write)
    writeFileSync(journalPath, JSON.stringify(event) + '\n{"ts":"2026-01-01",');

    const result = await readEvents(journalPath, {});
    expect(result).toHaveLength(1);
    expect(result[0].event_type).toBe('daemon.started');
  });

  it('should skip malformed JSON lines', async () => {
    writeFileSync(
      journalPath,
      [
        JSON.stringify(makeEvent({ event_type: 'daemon.started' })),
        'not valid json at all',
        JSON.stringify(makeEvent({ event_type: 'daemon.ready' })),
      ].join('\n') + '\n'
    );

    const result = await readEvents(journalPath, {});
    expect(result).toHaveLength(2);
    expect(result[0].event_type).toBe('daemon.started');
    expect(result[1].event_type).toBe('daemon.ready');
  });

  it('should combine type and since filters', async () => {
    const events: JournalEvent[] = [
      makeEvent({ event_type: 'session.start', ts: '2026-01-01T00:00:00.000Z' }),
      makeEvent({ event_type: 'session.start', ts: '2026-01-01T02:00:00.000Z' }),
      makeEvent({ event_type: 'daemon.ready', ts: '2026-01-01T02:00:00.000Z' }),
    ];
    writeJournal(journalPath, events);

    const result = await readEvents(journalPath, {
      type: 'session.start',
      since: '2026-01-01T01:00:00.000Z',
    });
    expect(result).toHaveLength(1);
    expect(result[0].ts).toBe('2026-01-01T02:00:00.000Z');
  });
});
