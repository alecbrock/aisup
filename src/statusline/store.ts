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

type TelemetryParse =
  | { ok: true; telemetry: StatuslineTelemetry }
  | { ok: false; reason: 'missing' | 'invalid_json'; error: string };

/** Read and parse a telemetry file, distinguishing a missing file from malformed JSON. */
function parseTelemetryFile(path: string): TelemetryParse {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return { ok: false, reason: 'missing', error: 'file not found' };
  }
  try {
    return { ok: true, telemetry: JSON.parse(raw) as StatuslineTelemetry };
  } catch (err) {
    // Safe summary only — the parser message, never the file contents.
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: 'invalid_json', error: message.slice(0, 160) };
  }
}

/** Convenience wrapper for callers that only need telemetry-or-null (account scoring, scan). */
function parseTelemetry(path: string): StatuslineTelemetry | null {
  const r = parseTelemetryFile(path);
  return r.ok ? r.telemetry : null;
}

/** True when the file's mtime is older than the freshness window (or cannot be read). */
function fileStale(path: string, freshnessWindowS: number): boolean {
  try {
    return Date.now() - lstatSync(path).mtime.getTime() > freshnessWindowS * 1000;
  } catch {
    return true;
  }
}

interface ProjectIdentityCheck { present: boolean; matches: boolean; }

/** A telemetry candidate carries project identity via cwd and/or workspace.project_dir. */
function checkProjectIdentity(t: StatuslineTelemetry, expectedCwd: string): ProjectIdentityCheck {
  const candidates: string[] = [];
  if (t.cwd) candidates.push(t.cwd);
  if (t.workspace?.project_dir) candidates.push(t.workspace.project_dir);
  if (candidates.length === 0) return { present: false, matches: false };
  return { present: true, matches: candidates.includes(expectedCwd) };
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

/**
 * Like readTelemetryForAccount but also returns the file mtime (epoch ms) — the moment the data was
 * true — so the usage ledger can tag entries live/aged accurately rather than assuming "now".
 */
export function readTelemetryWithMtimeForAccount(
  configDir: string,
  statuslineDir: string,
  freshnessWindowS: number
): { telemetry: StatuslineTelemetry; mtimeMs: number } | null {
  const files = listTelemetryFiles(statuslineDir, freshnessWindowS);
  for (const { path, mtime } of files) {
    const t = parseTelemetry(path);
    if (!t) continue;
    if (!t.transcript_path) continue;
    if (!transcriptMatchesAccount(t.transcript_path, configDir)) continue;
    return { telemetry: t, mtimeMs: mtime.getTime() };
  }
  return null;
}

export interface SessionTelemetryResult {
  telemetry: StatuslineTelemetry | null;
  mismatch: string | null;
  /** Set when the exact telemetry file exists but is not valid JSON. */
  invalidJson: { error: string; stale: boolean } | null;
}

/**
 * Read telemetry for a specific known claude session ID.
 * Accepts only telemetry belonging to the expected account (transcript under configDir),
 * the expected Claude session id, and the expected project identity (cwd or
 * workspace.project_dir). Surfaces malformed JSON so callers can emit telemetry.invalid_json.
 */
export function readTelemetryForSession(
  claudeSessionId: string,
  expectedConfigDir: string,
  expectedCwd: string,
  statuslineDir: string,
  freshnessWindowS = 300
): SessionTelemetryResult {
  const filePath = join(statuslineDir, `statusline-${claudeSessionId}.json`);
  const parsed = parseTelemetryFile(filePath);

  if (!parsed.ok) {
    if (parsed.reason === 'missing') return { telemetry: null, mismatch: null, invalidJson: null };
    return {
      telemetry: null,
      mismatch: null,
      invalidJson: { error: parsed.error, stale: fileStale(filePath, freshnessWindowS) },
    };
  }
  const t = parsed.telemetry;

  if (t.session_id !== claudeSessionId) {
    return {
      telemetry: null,
      mismatch: `session_id mismatch: expected ${claudeSessionId}, got ${t.session_id}`,
      invalidJson: null,
    };
  }

  if (t.transcript_path && !transcriptMatchesAccount(t.transcript_path, expectedConfigDir)) {
    return {
      telemetry: null,
      mismatch: `transcript account mismatch: ${t.transcript_path} not under ${expectedConfigDir}`,
      invalidJson: null,
    };
  }

  const identity = checkProjectIdentity(t, expectedCwd);
  if (!identity.present) {
    return {
      telemetry: null,
      mismatch: 'project identity missing: neither cwd nor workspace.project_dir present',
      invalidJson: null,
    };
  }
  if (!identity.matches) {
    return {
      telemetry: null,
      mismatch: `project identity mismatch: expected ${expectedCwd}`,
      invalidJson: null,
    };
  }

  return { telemetry: t, mismatch: null, invalidJson: null };
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
    const identity = checkProjectIdentity(t, expectedCwd);
    if (!identity.present || !identity.matches) continue;

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
      statuslineDir ?? '',
      freshnessWindowS ?? 300
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
    invalidJson: null,
  };
}
