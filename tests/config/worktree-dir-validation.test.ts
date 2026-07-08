import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig, resetConfigCache } from '../../src/config/loader.js';

/**
 * F-3: an absolute `workers.worktree_dir` must be rejected loudly at config load with a clear
 * "must be relative" message (the daemon-start path surfaces it to stderr instead of exiting blank).
 */
describe('F-3 worktree_dir validation', () => {
  let tmpDir: string;
  let accountDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'aisup-wtd-'));
    accountDir = join(tmpDir, '.claude');
    mkdirSync(accountDir, { recursive: true });
    resetConfigCache();
  });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); resetConfigCache(); });

  function writeConfig(worktreeDir: string): string {
    const configDir = join(tmpDir, '.aisup');
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
    const path = join(configDir, 'config.yaml');
    writeFileSync(path, `
accounts:
  - name: primary
    config_dir: ${accountDir}
    priority: 1
workers:
  worktree_dir: ${worktreeDir}
`);
    return path;
  }

  it('rejects an absolute worktree_dir with a clear "must be relative" error', async () => {
    await expect(loadConfig(writeConfig('/absolute/bad'))).rejects.toThrow(/worktree_dir must be relative/);
  });

  it('accepts a relative worktree_dir', async () => {
    const config = await loadConfig(writeConfig('.aisup-workers'));
    expect(config.workers.worktree_dir).toBe('.aisup-workers');
  });
});
