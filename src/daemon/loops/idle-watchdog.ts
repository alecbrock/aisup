import { statSync } from 'node:fs';

export function isSessionIdle(outputLogPath: string, idleBoundarySeconds: number): boolean {
  try {
    const st = statSync(outputLogPath, { throwIfNoEntry: false });
    if (!st) return false;
    const idleMs = Date.now() - st.mtime.getTime();
    return idleMs >= idleBoundarySeconds * 1000;
  } catch {
    return false;
  }
}

export class IdleWatchdog {
  private intervalMs: number;
  private onIdle: (sessionId: string) => void;
  private handle: ReturnType<typeof setInterval> | null = null;

  constructor(opts: { intervalMs: number; onIdle: (sessionId: string) => void }) {
    this.intervalMs = opts.intervalMs;
    this.onIdle = opts.onIdle;
  }

  start(tickFn?: () => void): void {
    if (this.handle) return;
    this.handle = setInterval(() => { if (tickFn) tickFn(); }, this.intervalMs);
  }

  stop(): void {
    if (this.handle) { clearInterval(this.handle); this.handle = null; }
  }
}
