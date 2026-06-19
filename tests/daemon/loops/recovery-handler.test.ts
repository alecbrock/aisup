import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { detect429InOutput, OutputCursor, readLogTail } from '../../../src/daemon/loops/recovery-handler.js';

describe('detect429InOutput', () => {
  it('should detect "rate limit" text', () => {
    expect(detect429InOutput('you have hit a rate limit')).toBe(true);
  });

  it('should detect "Too many requests" (case-insensitive)', () => {
    expect(detect429InOutput('Too Many Requests from this IP')).toBe(true);
  });

  it('should detect "429" literal', () => {
    expect(detect429InOutput('HTTP 429 error')).toBe(true);
  });

  it('should detect "usage cap"', () => {
    expect(detect429InOutput('You have reached your usage cap')).toBe(true);
  });

  it('should detect "wait N minutes"', () => {
    expect(detect429InOutput('Please wait 30 minutes before retrying')).toBe(true);
  });

  it('should return false for normal output', () => {
    expect(detect429InOutput('Task 3 completed successfully')).toBe(false);
  });

  // Innocent text that merely mentions rate limits must NOT trigger a failover. Regression for the
  // 2026-06-18 spurious 429: the /spec autocomplete example "add rate limiting to the login endpoint"
  // matched the old bare /rate limit/i and forced an account switch.
  it('should NOT detect a feature description that mentions rate limiting', () => {
    expect(detect429InOutput('/spec add rate limiting to the login endpoint')).toBe(false);
    expect(detect429InOutput('implement rate limiting middleware for the API')).toBe(false);
  });

  it('should NOT detect an unrelated "wait N minutes" with no retry context', () => {
    expect(detect429InOutput('wait 5 minutes for the build to finish')).toBe(false);
  });

  it('should NOT detect a "usage cap" feature mention without an error verb', () => {
    expect(detect429InOutput('we should add a usage cap to the billing tier')).toBe(false);
  });

  it('should strip ANSI escape codes before matching', () => {
    // ANSI color code wrapping "rate limit" text
    const ansiWrapped = '\x1b[31mrate limit exceeded\x1b[0m';
    expect(detect429InOutput(ansiWrapped)).toBe(true);
  });

  it('should return false for empty string', () => {
    expect(detect429InOutput('')).toBe(false);
  });
});

describe('readLogTail', () => {
  it('should read content from offset to EOF', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'aisup-rec-'));
    const logPath = join(tmpDir, 'output.log');
    writeFileSync(logPath, 'line1\nline2\nline3\n');
    try {
      const content = readLogTail(logPath, 0, 65536);
      expect(content).toContain('line1');
      expect(content).toContain('line3');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('should return empty string for missing file', () => {
    expect(readLogTail('/nonexistent/output.log', 0, 65536)).toBe('');
  });

  it('should respect 64KB scan window (reads at most last 64KB)', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'aisup-rec-'));
    const logPath = join(tmpDir, 'output.log');
    // Write 128KB of 'a' then 'RATE_LIMIT_MARKER\n'
    const padding = Buffer.alloc(128 * 1024, 'a');
    const marker = Buffer.from('\nRATE_LIMIT_MARKER\n');
    writeFileSync(logPath, Buffer.concat([padding, marker]));
    try {
      // With 64KB window, should see the marker (it's in the last 64KB)
      const content = readLogTail(logPath, 0, 65536);
      expect(content).toContain('RATE_LIMIT_MARKER');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('should start from cursor offset when larger than window start', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'aisup-rec-'));
    const logPath = join(tmpDir, 'output.log');
    writeFileSync(logPath, 'old-content\nnew-content\n');
    const oldLen = Buffer.byteLength('old-content\n');
    try {
      const content = readLogTail(logPath, oldLen, 65536);
      expect(content).not.toContain('old-content');
      expect(content).toContain('new-content');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('OutputCursor', () => {
  it('should initialize at given offset', () => {
    const cursor = new OutputCursor({ path: '/tmp/out.log', offset: 100, generation: 0 });
    expect(cursor.offset).toBe(100);
    expect(cursor.generation).toBe(0);
  });

  it('should update offset', () => {
    const cursor = new OutputCursor({ path: '/tmp/out.log', offset: 0, generation: 0 });
    cursor.advance(500);
    expect(cursor.offset).toBe(500);
  });

  it('should reset on rotation', () => {
    const cursor = new OutputCursor({ path: '/tmp/out.log', offset: 5000, generation: 0 });
    cursor.resetForRotation('/tmp/out.log');
    expect(cursor.offset).toBe(0);
    expect(cursor.generation).toBe(1);
  });

  it('should update path on rotation', () => {
    const cursor = new OutputCursor({ path: '/tmp/out.log', offset: 5000, generation: 0 });
    cursor.resetForRotation('/tmp/out.log.new');
    expect(cursor.path).toBe('/tmp/out.log.new');
  });
});
