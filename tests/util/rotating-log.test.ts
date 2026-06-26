import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RotatingLog } from '../../src/util/rotating-log.js';

describe('RotatingLog', () => {
  let tmpDir: string;
  let logPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'aisup-rotlog-'));
    logPath = join(tmpDir, 'daemon.log');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should write data to log file', () => {
    const log = new RotatingLog({ path: logPath, maxSizeMb: 1, maxFiles: 3 });
    log.write('hello\n');
    log.end();

    expect(readFileSync(logPath, 'utf8')).toBe('hello\n');
  });

  it('should rotate when size exceeds maxSizeMb', () => {
    const log = new RotatingLog({ path: logPath, maxSizeMb: 0.0001, maxFiles: 3 });
    const chunk = 'x'.repeat(200) + '\n';
    log.write(chunk);
    log.write(chunk);
    log.end();

    expect(existsSync(logPath)).toBe(true);
    expect(existsSync(`${logPath}.1`)).toBe(true);
    const currentSize = statSync(logPath).size;
    expect(currentSize).toBeLessThan(chunk.length * 2);
  });

  it('should keep writing to active file after rotation', () => {
    const log = new RotatingLog({ path: logPath, maxSizeMb: 0.0001, maxFiles: 3 });
    log.write('x'.repeat(200) + '\n');
    log.write('after-rotation\n');
    log.end();

    const content = readFileSync(logPath, 'utf8');
    expect(content).toContain('after-rotation');
  });

  // AF-301: write backs the daemon's stdout/stderr override — a sink failure must return false,
  // never throw, or it would crash the process from any console write.
  it('returns false (does not throw) when the log sink is unwritable', () => {
    const badPath = join(tmpDir, 'not-a-dir', 'daemon.log'); // parent dir does not exist
    const log = new RotatingLog({ path: badPath, maxSizeMb: 1, maxFiles: 3 });
    expect(() => log.write('hello\n')).not.toThrow();
    expect(log.write('hello\n')).toBe(false);
  });
});
