import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, symlinkSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  listTelemetryFiles,
  readTelemetryForActiveSession,
  readTelemetryForAccount,
  readTelemetryForSession,
  epochSecondsToDate,
} from '../../src/statusline/store.js';
import type { StatuslineTelemetry } from '../../src/statusline/types.js';
import type { SessionState } from '../../src/session/types.js';

const NOW_EPOCH = Math.floor(Date.now() / 1000);
const FUTURE_EPOCH = NOW_EPOCH + 3600;

function makeTelemetry(overrides: Partial<StatuslineTelemetry> = {}): StatuslineTelemetry {
  return {
    session_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    transcript_path: '/home/.claude/projects/foo/bar.jsonl',
    rate_limits: {
      five_hour: { used_percentage: 30, resets_at: FUTURE_EPOCH },
      seven_day: { used_percentage: 20, resets_at: FUTURE_EPOCH },
    },
    cwd: '/home/project',
    ...overrides,
  };
}

describe('epochSecondsToDate', () => {
  it('should convert epoch seconds to Date', () => {
    const d = epochSecondsToDate(1000000);
    expect(d).toBeInstanceOf(Date);
    expect(d.getTime()).toBe(1000000000);
  });

  it('should throw for non-number values', () => {
    expect(() => epochSecondsToDate('not-a-number' as unknown as number)).toThrow();
  });
});

describe('listTelemetryFiles', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'aisup-sl-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should return only UUID-named JSON files sorted by mtime desc', async () => {
    const id1 = 'aaaaaaaa-1111-1111-1111-111111111111';
    const id2 = 'bbbbbbbb-2222-2222-2222-222222222222';
    writeFileSync(join(tmpDir, `statusline-${id1}.json`), '{}');
    await new Promise((r) => setTimeout(r, 20));
    writeFileSync(join(tmpDir, `statusline-${id2}.json`), '{}');

    const files = listTelemetryFiles(tmpDir);
    expect(files.length).toBe(2);
    // most recent first
    expect(files[0].name).toContain(id2);
  });

  it('should exclude statusline-latest.json', () => {
    const id = 'aaaaaaaa-1111-1111-1111-111111111111';
    writeFileSync(join(tmpDir, `statusline-${id}.json`), '{}');
    writeFileSync(join(tmpDir, 'statusline-latest.json'), '{}');

    const files = listTelemetryFiles(tmpDir);
    expect(files.every((f) => !f.name.includes('latest'))).toBe(true);
  });

  it('should exclude symlinks', () => {
    const id = 'aaaaaaaa-1111-1111-1111-111111111111';
    const realFile = join(tmpDir, `statusline-${id}.json`);
    const symlinkId = 'cccccccc-3333-3333-3333-333333333333';
    const linkFile = join(tmpDir, `statusline-${symlinkId}.json`);
    writeFileSync(realFile, '{}');
    symlinkSync(realFile, linkFile);

    const files = listTelemetryFiles(tmpDir);
    expect(files).toHaveLength(1);
    expect(files[0].name).toContain(id);
  });

  it('should return empty array for missing directory', () => {
    expect(listTelemetryFiles(join(tmpDir, 'missing'))).toEqual([]);
  });
});

describe('readTelemetryForAccount', () => {
  let tmpDir: string;
  let statuslineDir: string;
  let configDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'aisup-sl-acc-'));
    statuslineDir = join(tmpDir, 'statusline');
    configDir = join(tmpDir, '.claude');
    mkdirSync(statuslineDir);
    mkdirSync(configDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should return telemetry matching account config dir', () => {
    const id = 'aaaaaaaa-1111-1111-1111-111111111111';
    writeFileSync(
      join(statuslineDir, `statusline-${id}.json`),
      JSON.stringify(makeTelemetry({ transcript_path: `${configDir}/projects/foo/bar.jsonl` }))
    );

    const result = readTelemetryForAccount(configDir, statuslineDir, 300);
    expect(result).not.toBeNull();
    expect(result!.session_id).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  });

  it('should not match account2 config dir against .claude prefix', () => {
    const configDir2 = join(tmpDir, '.claude-account2');
    mkdirSync(configDir2);
    const id = 'aaaaaaaa-1111-1111-1111-111111111111';
    writeFileSync(
      join(statuslineDir, `statusline-${id}.json`),
      JSON.stringify(makeTelemetry({ transcript_path: `${configDir2}/projects/foo/bar.jsonl` }))
    );

    // .claude should NOT match .claude-account2
    const result = readTelemetryForAccount(configDir, statuslineDir, 300);
    expect(result).toBeNull();
  });

  it('should skip invalid JSON files', () => {
    const id = 'aaaaaaaa-1111-1111-1111-111111111111';
    writeFileSync(join(statuslineDir, `statusline-${id}.json`), 'not valid json');
    const result = readTelemetryForAccount(configDir, statuslineDir, 300);
    expect(result).toBeNull();
  });

  it('should handle missing rate_limits gracefully', () => {
    const id = 'aaaaaaaa-1111-1111-1111-111111111111';
    writeFileSync(
      join(statuslineDir, `statusline-${id}.json`),
      JSON.stringify({ session_id: 'x', transcript_path: `${configDir}/projects/foo/bar.jsonl`, cwd: '/tmp' })
    );
    const result = readTelemetryForAccount(configDir, statuslineDir, 300);
    expect(result).not.toBeNull();
    expect(result!.rate_limits).toBeUndefined();
  });
});

describe('readTelemetryForSession', () => {
  let tmpDir: string;
  let statuslineDir: string;
  let configDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'aisup-sl-sess-'));
    statuslineDir = join(tmpDir, 'statusline');
    configDir = join(tmpDir, '.claude');
    mkdirSync(statuslineDir);
    mkdirSync(configDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should return telemetry when session_id matches', () => {
    const claudeId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    writeFileSync(
      join(statuslineDir, `statusline-${claudeId}.json`),
      JSON.stringify(makeTelemetry({
        session_id: claudeId,
        transcript_path: `${configDir}/projects/foo/bar.jsonl`,
        cwd: '/home/project',
      }))
    );

    const result = readTelemetryForSession(claudeId, configDir, '/home/project', statuslineDir);
    expect(result.telemetry).not.toBeNull();
    expect(result.mismatch).toBeNull();
  });

  it('should return mismatch when transcript is under wrong account', () => {
    const claudeId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const wrongDir = join(tmpDir, '.claude-other');
    writeFileSync(
      join(statuslineDir, `statusline-${claudeId}.json`),
      JSON.stringify(makeTelemetry({
        session_id: claudeId,
        transcript_path: `${wrongDir}/projects/foo/bar.jsonl`,
        cwd: '/home/project',
      }))
    );

    const result = readTelemetryForSession(claudeId, configDir, '/home/project', statuslineDir);
    expect(result.telemetry).toBeNull();
    expect(result.mismatch).toMatch(/transcript|account/i);
  });

  it('should return null telemetry when file does not exist', () => {
    const result = readTelemetryForSession('no-such-id', configDir, '/tmp', statuslineDir);
    expect(result.telemetry).toBeNull();
    expect(result.mismatch).toBeNull();
  });
});

describe('readTelemetryForActiveSession', () => {
  let tmpDir: string;
  let statuslineDir: string;
  let configDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'aisup-sl-active-'));
    statuslineDir = join(tmpDir, 'statusline');
    configDir = join(tmpDir, '.claude');
    mkdirSync(statuslineDir);
    mkdirSync(configDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('uses exact statusline file when claude_session_id is known', async () => {
    const knownId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const newerId = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';
    const session: SessionState = {
      aisup_session_id: 'sess-001',
      status: 'ACTIVE',
      account: 'primary',
      tmux_name: 'aisup-sess001',
      tmux_session_id: null,
      pane_id: null,
      cwd: '/home/project',
      launch_started_at: new Date().toISOString(),
      claude_session_id: knownId,
      transcript_path: null,
      plan_path: null,
      active_skill: null,
      output_log_path: join(tmpDir, 'output.log'),
      switch_tx: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    writeFileSync(
      join(statuslineDir, `statusline-${knownId}.json`),
      JSON.stringify(makeTelemetry({ session_id: knownId, transcript_path: `${configDir}/projects/known.jsonl`, cwd: '/home/project' }))
    );
    await new Promise((r) => setTimeout(r, 20));
    writeFileSync(
      join(statuslineDir, `statusline-${newerId}.json`),
      JSON.stringify(makeTelemetry({ session_id: newerId, transcript_path: `${configDir}/projects/newer.jsonl`, cwd: '/home/project' }))
    );

    const result = readTelemetryForActiveSession(session, configDir, statuslineDir, 300);
    expect(result.telemetry?.session_id).toBe(knownId);
    expect(result.mismatch).toBeNull();
  });
});
