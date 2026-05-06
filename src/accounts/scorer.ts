import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { AccountInfo } from './types.js';

interface RateLimitWindow {
  used_percentage: number;
  resets_at: number;
}

interface StatuslineTelemetry {
  transcript_path?: string;
  rate_limits?: {
    five_hour?: RateLimitWindow;
    seven_day?: RateLimitWindow;
  };
}

const UUID_PATTERN = /^statusline-[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\.json$/;

function listStatuslineFiles(dir: string): { path: string; mtime: Date }[] {
  try {
    return readdirSync(dir)
      .filter((f) => UUID_PATTERN.test(f))
      .map((f) => {
        const full = join(dir, f);
        const st = statSync(full, { throwIfNoEntry: false });
        if (!st || st.isSymbolicLink()) return null;
        return { path: full, mtime: st.mtime };
      })
      .filter((x): x is { path: string; mtime: Date } => x !== null)
      .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  } catch {
    return [];
  }
}

function computeScore(five: number, seven: number): number {
  return (100 - five) * 0.7 + (100 - seven) * 0.3;
}

/**
 * Score an account by reading its statusline telemetry.
 * Returns null when no valid fresh telemetry exists (caller uses priority fallback).
 * freshnessWindowS: seconds before a file is considered stale.
 */
export async function scoreAccount(
  configDir: string,
  statuslineDir: string,
  freshnessWindowS: number
): Promise<number | null> {
  const resolvedDir = resolve(configDir) + '/';
  const now = Date.now();
  const files = listStatuslineFiles(statuslineDir);

  for (const { path, mtime } of files) {
    let raw: StatuslineTelemetry;
    try {
      raw = JSON.parse(readFileSync(path, 'utf8')) as StatuslineTelemetry;
    } catch {
      continue;
    }

    const tp = raw.transcript_path ?? '';
    if (!tp.startsWith(resolvedDir)) continue;

    const rl = raw.rate_limits;
    if (!rl?.five_hour || !rl?.seven_day) continue;

    const fiveUsed = rl.five_hour.used_percentage;
    const sevenUsed = rl.seven_day.used_percentage;
    const fiveReset = rl.five_hour.resets_at;
    const sevenReset = rl.seven_day.resets_at;

    if (typeof fiveUsed !== 'number' || typeof sevenUsed !== 'number') continue;
    if (typeof fiveReset !== 'number' || typeof sevenReset !== 'number') continue;

    const resetEpochMs = Math.max(fiveReset, sevenReset) * 1000;

    // resets_at in the past → rate limit reset, capacity unknown → null regardless of freshness
    if (resetEpochMs < now) return null;

    const isStale = now - mtime.getTime() > freshnessWindowS * 1000;
    const base = computeScore(fiveUsed, sevenUsed);
    // Stale + resets_at in the future → apply 0.8 confidence multiplier
    return isStale ? base * 0.8 : base;
  }

  return null;
}

/** Select the best eligible account (HEALTHY or DEGRADED), excluding named accounts. */
export function selectBestAccount(
  accounts: AccountInfo[],
  exclude: string[] = []
): AccountInfo | null {
  const excludeSet = new Set(exclude);

  const eligible = accounts.filter(
    (a) => a.enabled && !excludeSet.has(a.name) && (a.state === 'HEALTHY' || a.state === 'DEGRADED')
  );

  if (eligible.length === 0) return null;

  return eligible.sort((a, b) => {
    // Higher score wins; null score → falls to priority comparison
    const aScore = a.score ?? -Infinity;
    const bScore = b.score ?? -Infinity;
    if (bScore !== aScore) return bScore - aScore;
    // Lower priority number wins
    if (a.priority !== b.priority) return a.priority - b.priority;
    // Alphabetical tiebreak
    return a.name.localeCompare(b.name);
  })[0] ?? null;
}
