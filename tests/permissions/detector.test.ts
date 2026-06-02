import { describe, it, expect } from 'vitest';
import { PermissionDetector, DEFAULT_PERMISSION_PATTERNS } from '../../src/permissions/detector.js';

describe('PermissionDetector', () => {
  it('exposes built-in default patterns', () => {
    expect(DEFAULT_PERMISSION_PATTERNS.length).toBeGreaterThan(0);
  });

  it('detects an "Allow <tool> to <action>" prompt and extracts tool + detail', () => {
    const d = new PermissionDetector([]);
    const reqs = d.scan('Allow Bash to run `git push origin main`?');
    expect(reqs).toHaveLength(1);
    expect(reqs[0].tool).toBe('Bash');
    expect(reqs[0].detail).toContain('git push origin main');
  });

  it('extracts tool and detail from a labelled prompt line', () => {
    const d = new PermissionDetector([]);
    const reqs = d.scan('Bash command: git push origin main');
    expect(reqs[0].tool).toBe('Bash');
    expect(reqs[0].detail).toBe('git push origin main');
  });

  it('detects a generic confirmation prompt with an unknown tool', () => {
    const d = new PermissionDetector([]);
    const reqs = d.scan('Do you want to proceed?');
    expect(reqs).toHaveLength(1);
    expect(reqs[0].tool).toBe('unknown');
    expect(reqs[0].detail.toLowerCase()).toContain('do you want to proceed');
  });

  it('deduplicates a prompt that persists across consecutive scans', () => {
    const d = new PermissionDetector([]);
    expect(d.scan('Do you want to proceed?')).toHaveLength(1);
    expect(d.scan('Do you want to proceed?')).toHaveLength(0); // same on-screen prompt re-rendered
  });

  it('re-detects an identical prompt after the previous one cleared', () => {
    const d = new PermissionDetector([]);
    expect(d.scan('Do you want to proceed?')).toHaveLength(1);
    expect(d.scan('... working ...')).toHaveLength(0);          // prompt cleared
    expect(d.scan('Do you want to proceed?')).toHaveLength(1);  // a genuinely new prompt
  });

  it('does not match ordinary prose containing "allow"', () => {
    const d = new PermissionDetector([]);
    expect(d.scan("I'll allow you to proceed with the plan once ready")).toHaveLength(0);
    expect(d.scan('the network allows connections to resume')).toHaveLength(0);
  });

  it('strips ANSI codes before matching', () => {
    const d = new PermissionDetector([]);
    expect(d.scan('\x1b[1mDo you want to proceed?\x1b[0m')).toHaveLength(1);
  });

  it('uses configured patterns instead of the defaults when provided', () => {
    const d = new PermissionDetector(['Confirm action: (?<detail>.+)']);
    const reqs = d.scan('Confirm action: delete all files');
    expect(reqs).toHaveLength(1);
    expect(reqs[0].detail).toBe('delete all files');
    // A line that only matches the built-in defaults is ignored under an override.
    expect(d.scan('Do you want to proceed?')).toHaveLength(0);
  });
});
