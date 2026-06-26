import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { scoreAccount, computeScore } from '../../src/accounts/scorer.js';

describe('computeScore (AF-321)', () => {
  it('clamps out-of-range used-percentages to [0,100] so headroom never goes negative or >100', () => {
    // >100% usage clamps to 100 → zero headroom, never a negative score.
    expect(computeScore(150, 0)).toBe(computeScore(100, 0));
    expect(computeScore(150, 200)).toBe(0);
    // negative usage clamps to 0 → full headroom, never >100.
    expect(computeScore(-50, -50)).toBe(100);
    // in-range values are unchanged.
    expect(computeScore(30, 20)).toBeCloseTo((100 - 30) * 0.7 + (100 - 20) * 0.3);
  });
});

const NOW_EPOCH = Math.floor(Date.now() / 1000);
const FUTURE_EPOCH = NOW_EPOCH + 3600; // resets in 1h
const PAST_EPOCH = NOW_EPOCH - 3600;   // reset 1h ago

function makeTelemetry(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    session_id: 'abc-123',
    transcript_path: '/home/.claude/projects/foo/bar.jsonl',
    rate_limits: {
      five_hour: { used_percentage: 30, resets_at: FUTURE_EPOCH },
      seven_day: { used_percentage: 20, resets_at: FUTURE_EPOCH },
    },
    ...overrides,
  });
}

describe('scoreAccount', () => {
  let tmpDir: string;
  let statuslineDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'aisup-scorer-'));
    statuslineDir = join(tmpDir, 'statusline');
    mkdirSync(statuslineDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should score based on fresh telemetry headroom', async () => {
    const configDir = join(tmpDir, '.claude');
    mkdirSync(configDir);

    // Write statusline file whose transcript path starts with configDir
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    writeFileSync(
      join(statuslineDir, `statusline-${sessionId}.json`),
      makeTelemetry({
        transcript_path: `${configDir}/projects/foo/bar.jsonl`,
        rate_limits: {
          five_hour: { used_percentage: 40, resets_at: FUTURE_EPOCH },
          seven_day: { used_percentage: 20, resets_at: FUTURE_EPOCH },
        },
      })
    );

    const score = scoreAccount(configDir, statuslineDir, 300);
    // score = (100-40)*0.7 + (100-20)*0.3 = 42 + 24 = 66
    expect(score).toBeCloseTo(66, 1);
  });

  it('should return null score when no telemetry files match account', async () => {
    const configDir = join(tmpDir, '.claude-other');
    mkdirSync(configDir);

    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    writeFileSync(
      join(statuslineDir, `statusline-${sessionId}.json`),
      makeTelemetry({ transcript_path: `${tmpDir}/.claude/projects/foo/bar.jsonl` })
    );

    const score = scoreAccount(configDir, statuslineDir, 300);
    expect(score).toBeNull();
  });

  it('should apply 0.8 multiplier for stale-future telemetry', async () => {
    const configDir = join(tmpDir, '.claude');
    mkdirSync(configDir);
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    // Write file then backdate it by making the freshness window very short
    writeFileSync(
      join(statuslineDir, `statusline-${sessionId}.json`),
      makeTelemetry({
        transcript_path: `${configDir}/projects/foo/bar.jsonl`,
        rate_limits: {
          five_hour: { used_percentage: 40, resets_at: FUTURE_EPOCH },
          seven_day: { used_percentage: 20, resets_at: FUTURE_EPOCH },
        },
      })
    );

    // Backdate mtime by 10s to guarantee staleness regardless of clock resolution
    const filePath = join(statuslineDir, `statusline-${sessionId}.json`);
    const tenSecondsAgo = new Date(Date.now() - 10000);
    utimesSync(filePath, tenSecondsAgo, tenSecondsAgo);

    // freshness_window_s=5 → file is 10s old → stale
    const score = scoreAccount(configDir, statuslineDir, 5);
    // stale-future: score * 0.8 = 66 * 0.8 = 52.8
    expect(score).toBeCloseTo(52.8, 1);
  });

  it('should return null score for stale-past telemetry (resets_at in the past)', async () => {
    const configDir = join(tmpDir, '.claude');
    mkdirSync(configDir);
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    writeFileSync(
      join(statuslineDir, `statusline-${sessionId}.json`),
      makeTelemetry({
        transcript_path: `${configDir}/projects/foo/bar.jsonl`,
        rate_limits: {
          five_hour: { used_percentage: 80, resets_at: PAST_EPOCH },
          seven_day: { used_percentage: 60, resets_at: PAST_EPOCH },
        },
      })
    );

    const score = scoreAccount(configDir, statuslineDir, 300);
    expect(score).toBeNull();
  });
});
