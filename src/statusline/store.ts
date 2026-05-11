import { readdirSync, readFileSync, lstatSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { StatuslineTelemetry, TelemetryFile } from './types.js';
import type { SessionState } from '../session/types.js';

const UUID_FILE_PATTERN = /^statusline-[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\.json$/;

export function epochSecondsToDate(seconds: number): Date {
  if (typeof seconds !== 'number') {
    throw new TypeError(`epochSecondsToDate: expected number, got ${typeof seconds}`);
  }
  return new Date(seconds * 1000);
}

export function listTelemetryFiles(dir: string, freshnessWindowS = 300): TelemetryFile[] {
  try {
    const now = Date.now();
    return readdirSync(dir)
      .filter((f) => UUID_FILE_PATTERN.test(f))
      .map((name) => {
        const path = join(dir, name);
        try {
          const st = lstatSync(path);
          if (st.isSymbolicLink()) return null;
          return {
            name,
            path,
            mtime: st.mtime,
            stale: now - st.mtime.getTime() > freshnessWindowS * 1000,
          };
        } catch {
          return null;
        }
      })
      .filter((x): x is TelemetryFile => x !== null)
      .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  } catch {
    return [];
  }
}

function parseTelemetry(path: string): StatuslineTelemetry | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as StatuslineTelemetry;
  } catch {
    return null;
  }
}

function transcriptMatchesAccount(transcriptPath: string, configDir: string): boolean {
  const resolved = resolve(configDir) + '/';
  return transcriptPath.startsWith(resolved);
}

/**
 * Return the freshest telemetry for an account (for scoring only — not session identity).
 */
export function readTelemetryForAccount(
  configDir: string,
  statuslineDir: string,
  freshnessWindowS: number
): StatuslineTelemetry | null {
  const files = listTelemetryFiles(statuslineDir, freshnessWindowS);
  for (const { path } of files) {
    const t = parseTelemetry(path);
    if (!t) continue;
    if (!t.transcript_path) continue;
    if (!transcriptMatchesAccount(t.transcript_path, configDir)) continue;
    return t;
  }
  return null;
}

export interface SessionTelemetryResult {
  telemetry: StatuslineTelemetry | null;
  mismatch: string | null;
}

/**
 * Read telemetry for a specific known claude session ID.
 * Validates transcript is under expectedAccount configDir and cwd matches.
 */
export function readTelemetryForSession(
  claudeSessionId: string,
  expectedConfigDir: string,
  expectedCwd: string,
  statuslineDir: string
): SessionTelemetryResult {
  const filePath = join(statuslineDir, `statusline-${claudeSessionId}.json`);
  const t = parseTelemetry(filePath);

  if (!t) return { telemetry: null, mismatch: null };

  if (t.session_id !== claudeSessionId) {
    return {
      telemetry: null,
      mismatch: `session_id mismatch: expected ${claudeSessionId}, got ${t.session_id}`,
    };
  }

  if (t.transcript_path && !transcriptMatchesAccount(t.transcript_path, expectedConfigDir)) {
    return {
      telemetry: null,
      mismatch: `transcript account mismatch: ${t.transcript_path} not under ${expectedConfigDir}`,
    };
  }

  if (t.cwd && t.cwd !== expectedCwd) {
    return {
      telemetry: null,
      mismatch: `cwd mismatch: expected ${expectedCwd}, got ${t.cwd}`,
    };
  }

  return { telemetry: t, mismatch: null };
}

/**
 * Scan for a matching statusline candidate before claude_session_id is known.
 * Accepts files with mtime ≥ launchStartedAt, transcript under current account, cwd matches.
 */
export interface ActiveTelemetryScanOpts {
  launchStartedAt: string;
  currentAccountConfigDir: string;
  expectedCwd: string;
  statuslineDir: string;
  freshnessWindowS: number;
}

function scanTelemetryForActiveSession(opts: ActiveTelemetryScanOpts): StatuslineTelemetry | null {
  const { launchStartedAt, currentAccountConfigDir, expectedCwd, statuslineDir, freshnessWindowS } = opts;
  const launchMs = new Date(launchStartedAt).getTime();
  const CLOCK_SKEW_MS = 2000;

  const files = listTelemetryFiles(statuslineDir, freshnessWindowS);
  for (const { path, mtime } of files) {
    if (mtime.getTime() < launchMs - CLOCK_SKEW_MS) continue;

    const t = parseTelemetry(path);
    if (!t) continue;
    if (!t.transcript_path) continue;
    if (!transcriptMatchesAccount(t.transcript_path, currentAccountConfigDir)) continue;
    if (t.cwd && t.cwd !== expectedCwd) continue;

    return t;
  }
  return null;
}

export function readTelemetryForActiveSession(opts: ActiveTelemetryScanOpts): StatuslineTelemetry | null;
export function readTelemetryForActiveSession(
  session: Pick<SessionState, 'launch_started_at' | 'cwd' | 'claude_session_id'>,
  currentAccountConfigDir: string,
  statuslineDir: string,
  freshnessWindowS: number
): SessionTelemetryResult;
export function readTelemetryForActiveSession(
  first: ActiveTelemetryScanOpts | Pick<SessionState, 'launch_started_at' | 'cwd' | 'claude_session_id'>,
  currentAccountConfigDir?: string,
  statuslineDir?: string,
  freshnessWindowS?: number
): StatuslineTelemetry | null | SessionTelemetryResult {
  if ('launchStartedAt' in first) {
    return scanTelemetryForActiveSession(first);
  }

  if (first.claude_session_id) {
    return readTelemetryForSession(
      first.claude_session_id,
      currentAccountConfigDir ?? '',
      first.cwd,
      statuslineDir ?? ''
    );
  }

  return {
    telemetry: scanTelemetryForActiveSession({
      launchStartedAt: first.launch_started_at,
      currentAccountConfigDir: currentAccountConfigDir ?? '',
      expectedCwd: first.cwd,
      statuslineDir: statuslineDir ?? '',
      freshnessWindowS: freshnessWindowS ?? 300,
    }),
    mismatch: null,
  };
}
