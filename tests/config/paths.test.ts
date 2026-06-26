import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';

import { aisupHome } from '../../src/config/paths.js';
import { loadConfig, resetConfigCache } from '../../src/config/loader.js';
import { WorkerStore } from '../../src/workers/store.js';

describe('AISUP_HOME state-dir isolation', () => {
  let tmpDir: string;
  let origHome: string | undefined;
  let origAisupHome: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'aisup-home-'));
    origHome = process.env.HOME;
    origAisupHome = process.env.AISUP_HOME;
    resetConfigCache();
  });

  afterEach(() => {
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    if (origAisupHome === undefined) delete process.env.AISUP_HOME;
    else process.env.AISUP_HOME = origAisupHome;
    rmSync(tmpDir, { recursive: true, force: true });
    resetConfigCache();
  });

  it('falls back to ~/.aisup when AISUP_HOME is unset', () => {
    delete process.env.AISUP_HOME;
    expect(aisupHome()).toBe(join(homedir(), '.aisup'));
  });

  it('treats an empty AISUP_HOME as unset', () => {
    process.env.AISUP_HOME = '';
    expect(aisupHome()).toBe(join(homedir(), '.aisup'));
  });

  it('relocates the state-dir root when AISUP_HOME is set', () => {
    process.env.AISUP_HOME = tmpDir;
    expect(aisupHome()).toBe(tmpDir);
  });

  it('relocates the worker store dir under AISUP_HOME', () => {
    process.env.AISUP_HOME = tmpDir;
    const store = new WorkerStore();
    const id = '00000000-0000-4000-8000-000000000000';
    expect(store.dir(id)).toBe(join(tmpDir, 'workers', id));
  });

  it('resolves the config path and the journal default under AISUP_HOME (CR-001)', async () => {
    process.env.AISUP_HOME = tmpDir;
    process.env.HOME = tmpDir; // keep any placeholder .claude dirs inside the temp dir
    const accountDir = join(tmpDir, '.claude');
    mkdirSync(accountDir, { recursive: true });
    // Config WITHOUT a journal override → the default journal.jsonl must resolve under
    // AISUP_HOME, not the operator's real ~/.aisup. loadConfig() with no arg must read
    // config.yaml from under AISUP_HOME too.
    const cfg = `accounts:\n  - name: primary\n    config_dir: ${accountDir}\n    priority: 1\n`;
    writeFileSync(join(tmpDir, 'config.yaml'), cfg);
    resetConfigCache();

    const config = await loadConfig();

    expect(config.journal.path).toBe(join(tmpDir, 'journal.jsonl'));
  });

  it('journal default falls back to ~/.aisup/journal.jsonl when AISUP_HOME is unset', async () => {
    delete process.env.AISUP_HOME;
    process.env.HOME = tmpDir;
    const aisupDir = join(tmpDir, '.aisup');
    mkdirSync(aisupDir, { recursive: true });
    const accountDir = join(tmpDir, '.claude');
    mkdirSync(accountDir, { recursive: true });
    const cfg = `accounts:\n  - name: primary\n    config_dir: ${accountDir}\n    priority: 1\n`;
    writeFileSync(join(aisupDir, 'config.yaml'), cfg);
    resetConfigCache();

    const config = await loadConfig(join(aisupDir, 'config.yaml'));

    expect(config.journal.path).toBe(join(tmpDir, '.aisup', 'journal.jsonl'));
  });
});
