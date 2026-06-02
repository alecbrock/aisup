import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AccountRegistry } from '../../src/accounts/registry.js';
import { CircuitBreaker } from '../../src/accounts/circuit-breaker.js';
import { refreshAccountScores } from '../../src/accounts/refresh.js';
import { selectSwitchTarget } from '../../src/failover/switcher.js';
import type { AisupConfig } from '../../src/config/schema.js';

const NOW_EPOCH = Math.floor(Date.now() / 1000);
const FUTURE_EPOCH = NOW_EPOCH + 3600;

let tmpDir: string;
let statuslineDir: string;

function accountDir(name: string): string {
  const dir = join(tmpDir, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

let fileCounter = 0;
function uuidName(): string {
  // Deterministic-ish unique UUID-shaped name per call.
  const n = (fileCounter++).toString(16).padStart(12, '0');
  return `aaaaaaaa-bbbb-cccc-dddd-${n}`;
}

function writeTelemetry(configDir: string, fivePct: number, sevenPct: number, resetEpoch = FUTURE_EPOCH): void {
  const id = uuidName();
  writeFileSync(
    join(statuslineDir, `statusline-${id}.json`),
    JSON.stringify({
      session_id: id,
      transcript_path: `${configDir}/projects/foo/${id}.jsonl`,
      rate_limits: {
        five_hour: { used_percentage: fivePct, resets_at: resetEpoch },
        seven_day: { used_percentage: sevenPct, resets_at: resetEpoch },
      },
    })
  );
}

function makeRegistry(accounts: Array<{ name: string; dir: string; priority: number; enabled?: boolean }>): AccountRegistry {
  const config = {
    accounts: accounts.map((a) => ({
      name: a.name,
      config_dir: a.dir,
      priority: a.priority,
      enabled: a.enabled ?? true,
    })),
  } as AisupConfig;
  return new AccountRegistry(config);
}

describe('refreshAccountScores', () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'aisup-refresh-'));
    statuslineDir = join(tmpDir, 'statusline');
    mkdirSync(statuslineDir);
    fileCounter = 0;
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('refreshes null scores from telemetry so a lower-priority higher-score account wins', () => {
    const primaryDir = accountDir('primary');
    const secondaryDir = accountDir('secondary');
    // primary heavily used (low headroom → low score); secondary fresh (high headroom → high score)
    writeTelemetry(primaryDir, 90, 80);
    writeTelemetry(secondaryDir, 10, 5);

    const registry = makeRegistry([
      { name: 'primary', dir: primaryDir, priority: 1 },
      { name: 'secondary', dir: secondaryDir, priority: 2 },
    ]);
    // Precondition: both null before refresh
    expect(registry.get('primary')?.score).toBeNull();
    expect(registry.get('secondary')?.score).toBeNull();

    refreshAccountScores({
      registry,
      statuslineDir,
      freshnessWindowS: 300,
      softPct: 85,
      hardPct: 95,
    });

    const primary = registry.get('primary')!;
    const secondary = registry.get('secondary')!;
    expect(typeof primary.score).toBe('number');
    expect(typeof secondary.score).toBe('number');
    expect(secondary.score!).toBeGreaterThan(primary.score!);

    // Canonical selector now prefers the lower-priority, higher-score account.
    const winner = selectSwitchTarget(registry.getAll(), '', []);
    expect(winner?.name).toBe('secondary');
  });

  it('drives an account to DEGRADED when soft threshold is crossed by telemetry', () => {
    const dir = accountDir('primary');
    writeTelemetry(dir, 88, 20); // five-hour 88% ≥ soft 85, < hard 95

    const registry = makeRegistry([{ name: 'primary', dir, priority: 1 }]);
    refreshAccountScores({ registry, statuslineDir, freshnessWindowS: 300, softPct: 85, hardPct: 95 });

    expect(registry.get('primary')?.state).toBe('DEGRADED');
  });

  it('drives an account to UNAVAILABLE with a cooldown when hard threshold is crossed by telemetry', () => {
    const dir = accountDir('primary');
    writeTelemetry(dir, 96, 20); // five-hour 96% ≥ hard 95

    const registry = makeRegistry([{ name: 'primary', dir, priority: 1 }]);
    refreshAccountScores({ registry, statuslineDir, freshnessWindowS: 300, softPct: 85, hardPct: 95 });

    const acct = registry.get('primary')!;
    expect(acct.state).toBe('UNAVAILABLE');
    expect(acct.cooldownUntil).toBeInstanceOf(Date);
  });

  it('marks an account COOLDOWN when its circuit breaker is OPEN', () => {
    const dir = accountDir('primary');
    writeTelemetry(dir, 10, 5); // healthy telemetry

    const registry = makeRegistry([{ name: 'primary', dir, priority: 1 }]);
    const cbPath = join(tmpDir, 'cb-state.json');
    const circuitBreaker = new CircuitBreaker({ maxFailures: 2, cooldownSeconds: 600, statePath: cbPath });
    circuitBreaker.recordFailure('primary');
    circuitBreaker.recordFailure('primary'); // trips OPEN
    expect(circuitBreaker.getState('primary')).toBe('OPEN');

    refreshAccountScores({ registry, statuslineDir, freshnessWindowS: 300, softPct: 85, hardPct: 95, circuitBreaker });

    const acct = registry.get('primary')!;
    expect(acct.state).toBe('COOLDOWN');
    // COOLDOWN accounts are excluded from automatic selection.
    expect(selectSwitchTarget(registry.getAll(), '', [])).toBeNull();
  });

  it('sets score to null when no telemetry matches the account', () => {
    const dir = accountDir('primary');
    // no statusline file written for this account
    const registry = makeRegistry([{ name: 'primary', dir, priority: 1 }]);
    registry.setScore('primary', 42); // stale score from a prior refresh
    refreshAccountScores({ registry, statuslineDir, freshnessWindowS: 300, softPct: 85, hardPct: 95 });
    expect(registry.get('primary')?.score).toBeNull();
  });
});
