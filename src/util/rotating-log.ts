import { appendFileSync, statSync, renameSync, writeFileSync } from 'node:fs';

export interface RotatingLogOpts {
  path: string;
  maxSizeMb: number;
  maxFiles: number;
}

export class RotatingLog {
  private path: string;
  private maxBytes: number;
  private maxFiles: number;
  private bytesWritten: number;

  constructor(opts: RotatingLogOpts) {
    this.path = opts.path;
    this.maxBytes = opts.maxSizeMb * 1024 * 1024;
    this.maxFiles = opts.maxFiles;

    try {
      const st = statSync(this.path, { throwIfNoEntry: false });
      this.bytesWritten = st?.size ?? 0;
    } catch {
      this.bytesWritten = 0;
    }
  }

  write(data: string | Uint8Array): boolean {
    // ⛔ NEVER throws (AF-301): this backs the daemon's stdout/stderr override, so a throw here from
    // a transient disk/permission error would propagate out of *any* console write and crash the
    // process. The log sink is exactly what failed, so we cannot log the error — swallow + return false.
    try {
      const buf = typeof data === 'string' ? data : Buffer.from(data);
      appendFileSync(this.path, buf, { mode: 0o600 });
      const len = typeof data === 'string' ? Buffer.byteLength(data) : data.length;
      this.bytesWritten += len;

      if (this.bytesWritten > this.maxBytes) {
        this.rotate();
      }

      return true;
    } catch {
      return false;
    }
  }

  private rotate(): void {
    for (let i = this.maxFiles - 1; i >= 1; i--) {
      const src = i === 1 ? this.path : `${this.path}.${i - 1}`;
      const dest = `${this.path}.${i}`;
      try { renameSync(src, dest); } catch { /* file may not exist */ }
    }

    writeFileSync(this.path, '', { mode: 0o600 });
    this.bytesWritten = 0;
  }

  end(): void {
    // no-op for sync implementation
  }
}
