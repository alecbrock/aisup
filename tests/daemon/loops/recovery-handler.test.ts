import { describe, it, expect } from 'vitest';
import { detect429InOutput, OutputCursor } from '../../../src/daemon/loops/recovery-handler.js';

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

  it('should strip ANSI escape codes before matching', () => {
    // ANSI color code wrapping "rate limit" text
    const ansiWrapped = '\x1b[31mrate limit exceeded\x1b[0m';
    expect(detect429InOutput(ansiWrapped)).toBe(true);
  });

  it('should return false for empty string', () => {
    expect(detect429InOutput('')).toBe(false);
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
