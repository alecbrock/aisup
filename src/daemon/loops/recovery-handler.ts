import { openSync, fstatSync, readSync, closeSync } from 'node:fs';
import stripAnsi from 'strip-ansi';

// Real rate-limit/quota errors only. Each pattern requires error/quota context so innocent prose
// ("add rate limiting to the endpoint", "wait 5 minutes for the build") never forces a failover —
// the bare /rate limit/i and /wait.*minutes/i caused exactly that (spurious 429, 2026-06-18).
const RATE_LIMIT_PATTERNS = [
  /\b429\b/,
  /too many requests/i,
  /rate_limit_error/i,
  /\b(?:hit|exceeded|reached)\b[^.\n]{0,25}\brate[ _-]?limit/i,                  // "hit/exceeded/reached … rate limit"
  /\brate[ _-]?limit(?:ed|ing)?\b[^.\n]{0,25}\b(?:error|exceeded|reached|reset)/i, // "rate limit exceeded/reached/reset"
  /\b(?:reached|hit|exceeded)\b[^.\n]{0,25}usage (?:cap|limit)/i,                // "reached your usage cap/limit"
  /wait[^.\n]{0,30}(?:minutes?|hours?)[^.\n]{0,20}(?:retry|retrying)/i,          // "wait N minutes … retry"
];

export function detect429InOutput(text: string): boolean {
  const clean = stripAnsi(text);
  return RATE_LIMIT_PATTERNS.some((p) => p.test(clean));
}

/**
 * Read up to `windowBytes` of content from a log file, starting from
 * `max(cursorOffset, fileSize - windowBytes)` to EOF.
 * Returns empty string if file is missing or empty.
 */
export function readLogTail(logPath: string, cursorOffset: number, windowBytes: number): string {
  let fd: number;
  try {
    fd = openSync(logPath, 'r');
  } catch {
    return '';
  }
  try {
    const stat = fstatSync(fd);
    const fileSize = stat.size;
    if (fileSize === 0) return '';
    const windowStart = Math.max(0, fileSize - windowBytes);
    const readFrom = Math.max(cursorOffset, windowStart);
    const toRead = fileSize - readFrom;
    if (toRead <= 0) return '';
    const buf = Buffer.allocUnsafe(toRead);
    const bytesRead = readSync(fd, buf, 0, toRead, readFrom);
    return buf.slice(0, bytesRead).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

export interface CursorState {
  path: string;
  offset: number;
  generation: number;
}

export class OutputCursor {
  path: string;
  offset: number;
  generation: number;

  constructor(state: CursorState) {
    this.path = state.path;
    this.offset = state.offset;
    this.generation = state.generation;
  }

  advance(newOffset: number): void {
    this.offset = newOffset;
  }

  resetForRotation(newPath: string): void {
    this.path = newPath;
    this.offset = 0;
    this.generation += 1;
  }

  toState(): CursorState {
    return { path: this.path, offset: this.offset, generation: this.generation };
  }
}

export interface RecoveryHandlerOpts {
  intervalMs: number;
  onCrashDetected: (sessionId: string, has429: boolean) => void;
}

export class RecoveryHandler {
  private intervalMs: number;
  private onCrash: (sessionId: string, has429: boolean) => void;
  private handle: ReturnType<typeof setInterval> | null = null;
  private cursors: Map<string, OutputCursor> = new Map();

  constructor(opts: RecoveryHandlerOpts) {
    this.intervalMs = opts.intervalMs;
    this.onCrash = opts.onCrashDetected;
  }

  initCursor(sessionId: string, logPath: string, offset: number): void {
    this.cursors.set(sessionId, new OutputCursor({ path: logPath, offset, generation: 0 }));
  }

  getCursor(sessionId: string): OutputCursor | undefined {
    return this.cursors.get(sessionId);
  }

  removeCursor(sessionId: string): void {
    this.cursors.delete(sessionId);
  }

  /** Get current file size for a log path (used to init cursor at EOF). */
  static getFileSize(logPath: string): number {
    let fd: number;
    try {
      fd = openSync(logPath, 'r');
    } catch {
      return 0;
    }
    try {
      return fstatSync(fd).size;
    } finally {
      closeSync(fd);
    }
  }

  start(tickFn?: () => void): void {
    if (this.handle) return;
    this.handle = setInterval(() => { if (tickFn) tickFn(); }, this.intervalMs);
  }

  stop(): void {
    if (this.handle) {
      clearInterval(this.handle);
      this.handle = null;
    }
  }
}
