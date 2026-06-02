import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { selectDryRunAccount } from '../../src/cli/commands/start.js';
import type { AisupConfig } from '../../src/config/schema.js';

const FUTURE_EPOCH = Math.floor(Date.now() / 1000) + 3600;

let tmpDir: string;
let statuslineDir: string;
let cbPath: string;

function accountDir(name: string): string {
  const dir = join(tmpDir, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeTelemetry(configDir: string, fivePct: number, sevenPct: number): void {
  const id = `aaaaaaaa-bbbb-cccc-dddd-${Math.random().toString(16).slice(2, 14).padEnd(12, '0')}`;
  writeFileSync(
    join(statuslineDir, `statusline-${id}.json`),
    JSON.stringify({
      session_id: id,
      transcript_path: `${configDir}/projects/foo/${id}.jsonl`,
      rate_limits: {
        five_hour: { used_percentage: fivePct, resets_at: FUTURE_EPOCH },
        seven_day: { used_percentage: sevenPct, resets_at: FUTURE_EPOCH },
      },
    })
  );
}

function makeConfig(accounts: Array<{ name: string; dir: string; priority: number }>): AisupConfig {
  return {
    accounts: accounts.map((a) => ({ name: a.name, config_dir: a.dir, priority: a.priority, enabled: true })),
    thresholds: { soft_pct: 85, hard_pct: 95, idle_boundary_seconds: 30 },
    failover: { circuit_breaker_max_failures: 3, circuit_breaker_cooldown_seconds: 600 },
    statusline: { directory: statuslineDir, freshness_window_s: 300 },
  } as AisupConfig;
}

describe('selectDryRunAccount', () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'aisup-dryrun-'));
    statuslineDir = join(tmpDir, 'statusline');
    mkdirSync(statuslineDir);
    cbPath = join(tmpDir, 'circuit-breaker-state.json');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reports the scored selection, not the priority-order account', () => {
    const primaryDir = accountDir('primary');
    const secondaryDir = accountDir('secondary');
    writeTelemetry(primaryDir, 90, 80);  // low headroom
    writeTelemetry(secondaryDir, 10, 5); // high headroom

    const config = makeConfig([
      { name: 'primary', dir: primaryDir, priority: 1 },
      { name: 'secondary', dir: secondaryDir, priority: 2 },
    ]);
    const selected = selectDryRunAccount(config, cbPath);
    expect(selected?.name).toBe('secondary');
  });

  it('skips an account whose persisted circuit breaker is OPEN', () => {
    const primaryDir = accountDir('primary');
    const secondaryDir = accountDir('secondary');
    writeTelemetry(primaryDir, 90, 80);
    writeTelemetry(secondaryDir, 10, 5);
    // secondary would win on score, but its breaker is OPEN on disk → excluded.
    writeFileSync(
      cbPath,
      JSON.stringify({ secondary: { failures: 5, state: 'OPEN', openedAt: new Date().toISOString() } })
    );

    const config = makeConfig([
      { name: 'primary', dir: primaryDir, priority: 1 },
      { name: 'secondary', dir: secondaryDir, priority: 2 },
    ]);
    const selected = selectDryRunAccount(config, cbPath);
    expect(selected?.name).toBe('primary');
  });
});
