import stripAnsi from 'strip-ansi';

const RATE_LIMIT_PATTERNS = [
  /rate limit/i,
  /too many requests/i,
  /429/,
  /usage cap/i,
  /wait.*minutes/i,
];

export function detect429InOutput(text: string): boolean {
  const clean = stripAnsi(text);
  return RATE_LIMIT_PATTERNS.some((p) => p.test(clean));
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

  start(): void {
    if (this.handle) return;
    this.handle = setInterval(() => { /* tick wired by daemon */ }, this.intervalMs);
  }

  stop(): void {
    if (this.handle) {
      clearInterval(this.handle);
      this.handle = null;
    }
  }
}
