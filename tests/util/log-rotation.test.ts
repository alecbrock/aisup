import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readEvents } from '../../src/journal/reader.js';
import { RotatingLog } from '../../src/util/rotating-log.js';
import { createJournalWriter } from '../../src/journal/writer.js';

describe('D3: log + journal rotation honor the configured size', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'aisup-rot-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('RotatingLog rotates at a NON-default small size (not the hard-coded 10MB)', () => {
    const path = join(dir, 'daemon.log');
    const log = new RotatingLog({ path, maxSizeMb: 0.001, maxFiles: 3 }); // ~1KB threshold
    log.write('x'.repeat(2048)); // exceeds 1KB → rotates
    expect(existsSync(`${path}.1`)).toBe(true);
    expect(statSync(path).size).toBeLessThan(2048); // current file reset after rotation
  });

  it('createJournalWriter rotates the journal at the configured max size and records journal.rotated', async () => {
    const path = join(dir, 'journal.jsonl');
    const writer = createJournalWriter(path, 0.002); // ~2KB threshold
    for (let i = 0; i < 60; i++) {
      await writer.append({ ts: new Date().toISOString(), event_type: 'cost.snapshot', details: { total_cost_usd: i, filler: 'y'.repeat(60) } });
    }
    expect(existsSync(`${path}.1`)).toBe(true); // rotated backup exists
    const events = await readEvents(path, { limit: 100 });
    expect(events.some((e) => e.event_type === 'journal.rotated')).toBe(true);
  });

  it('does not rotate when max size is unset (Infinity)', async () => {
    const path = join(dir, 'journal2.jsonl');
    writeFileSync(path, '');
    const writer = createJournalWriter(path); // no maxSizeMb
    for (let i = 0; i < 50; i++) {
      await writer.append({ ts: new Date().toISOString(), event_type: 'cost.snapshot', details: { total_cost_usd: i } });
    }
    expect(existsSync(`${path}.1`)).toBe(false);
  });
});
