import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { UsageLedger } from '../../src/accounts/usage-ledger.js';

const SEC = 1000;
const MIN = 60 * SEC;

describe('UsageLedger', () => {
  let dir: string;
  let path: string;
  const NOW = 1_781_734_726_000; // fixed "now" in ms (injected, never Date.now)

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aisup-ledger-'));
    path = join(dir, 'usage-ledger.json');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function epochSec(ms: number): number {
    return Math.floor(ms / 1000);
  }

  it('returns unknown for an account never captured', () => {
    const led = new UsageLedger(path);
    const est = led.estimate('primary', NOW);
    expect(est.five_hour).toEqual({ used_pct: null, basis: 'unknown' });
    expect(est.seven_day).toEqual({ used_pct: null, basis: 'unknown' });
  });

  it('returns the captured value as "live" when captured within the freshness window', () => {
    const led = new UsageLedger(path, 5 * MIN);
    led.capture('account2', {
      five_hour: { used_pct: 36, reset_at: epochSec(NOW + 3 * 60 * MIN) },
      seven_day: { used_pct: 17, reset_at: epochSec(NOW + 5 * 24 * 60 * MIN) },
    }, NOW - 1 * MIN); // captured 1 min ago → live
    const est = led.estimate('account2', NOW);
    expect(est.five_hour).toEqual({ used_pct: 36, basis: 'live' });
    expect(est.seven_day).toEqual({ used_pct: 17, basis: 'live' });
  });

  it('DECAYS a window to 0% once its reset_at has passed (the idle-account fix)', () => {
    const led = new UsageLedger(path, 5 * MIN);
    // Captured a day ago at 100%, but the 5h window reset 23h ago → must read 0% now.
    led.capture('primary', {
      five_hour: { used_pct: 100, reset_at: epochSec(NOW - 23 * 60 * MIN) }, // reset in the past
      seven_day: { used_pct: 15, reset_at: epochSec(NOW + 2 * 24 * 60 * MIN) }, // still future
    }, NOW - 27 * 60 * MIN); // captured 27h ago
    const est = led.estimate('primary', NOW);
    expect(est.five_hour).toEqual({ used_pct: 0, basis: 'reset' }); // provably reset
    expect(est.seven_day).toEqual({ used_pct: 15, basis: 'aged' }); // held, but flagged not-live
  });

  it('holds the captured value as "aged" when stale but the window has not reset', () => {
    const led = new UsageLedger(path, 5 * MIN);
    led.capture('primary', {
      five_hour: { used_pct: 50, reset_at: epochSec(NOW + 60 * MIN) }, // future
    }, NOW - 30 * MIN); // captured 30 min ago → beyond 5min freshness
    const est = led.estimate('primary', NOW);
    expect(est.five_hour).toEqual({ used_pct: 50, basis: 'aged' });
    expect(est.seven_day.basis).toBe('unknown'); // not captured
  });

  it('persists across instances (round-trip) and writes a 0600 file', () => {
    const led = new UsageLedger(path, 5 * MIN);
    led.capture('account2', {
      five_hour: { used_pct: 42, reset_at: epochSec(NOW + 60 * MIN) },
    }, NOW - 1 * MIN);
    expect(existsSync(path)).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);

    const reloaded = new UsageLedger(path, 5 * MIN);
    expect(reloaded.estimate('account2', NOW).five_hour).toEqual({ used_pct: 42, basis: 'live' });
  });

  it('overwrites a window on re-capture (refresh on re-entry)', () => {
    const led = new UsageLedger(path, 5 * MIN);
    led.capture('account2', { five_hour: { used_pct: 80, reset_at: epochSec(NOW + 60 * MIN) } }, NOW - 10 * MIN);
    led.capture('account2', { five_hour: { used_pct: 12, reset_at: epochSec(NOW + 120 * MIN) } }, NOW);
    expect(led.estimate('account2', NOW).five_hour).toEqual({ used_pct: 12, basis: 'live' });
  });

  it('tolerates a corrupt ledger file (starts empty, does not throw)', () => {
    const led = new UsageLedger(path, 5 * MIN);
    led.capture('a', { five_hour: { used_pct: 1, reset_at: epochSec(NOW + MIN) } }, NOW);
    // corrupt it
    rmSync(path);
    require('node:fs').writeFileSync(path, '{not json');
    const led2 = new UsageLedger(path, 5 * MIN);
    expect(led2.estimate('a', NOW).five_hour.basis).toBe('unknown');
  });
});
