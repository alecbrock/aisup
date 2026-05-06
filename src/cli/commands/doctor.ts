import { execFileSync } from 'node:child_process';
import { existsSync, accessSync, constants } from 'node:fs';
import { loadConfig } from '../../config/loader.js';
import { validateRunner } from '../../runner/builder.js';

interface Check { label: string; ok: boolean; detail?: string }

function check(label: string, fn: () => string | true): Check {
  try {
    const r = fn();
    return { label, ok: true, detail: r === true ? undefined : r };
  } catch (e: unknown) {
    return { label, ok: false, detail: String(e) };
  }
}

export async function runDoctor(): Promise<void> {
  const checks: Check[] = [];

  // Node.js version
  checks.push(check('Node.js ≥22', () => {
    const [major] = process.versions.node.split('.').map(Number);
    if (major < 22) throw new Error(`Node.js ${process.versions.node} < 22`);
    return `v${process.versions.node}`;
  }));

  // tmux version
  checks.push(check('tmux ≥3.2', () => {
    const ver = execFileSync('tmux', ['-V'], { encoding: 'utf8' }).trim();
    const match = ver.match(/tmux\s+(\d+)\.(\d+)/);
    if (!match) throw new Error('cannot parse tmux version');
    const [, maj, min] = match.map(Number);
    if (maj < 3 || (maj === 3 && min < 2)) throw new Error(`${ver} < 3.2`);
    return ver;
  }));

  // Load config
  let config;
  try {
    config = await loadConfig();
  } catch (e) {
    checks.push({ label: 'Config valid', ok: false, detail: String(e) });
    printResults(checks);
    return;
  }
  checks.push({ label: 'Config valid', ok: true });

  // Runner binary
  checks.push(check('Runner binary exists', () => validateRunner(config.runner)));

  // Account config dirs
  for (const acct of config.accounts) {
    checks.push(check(`Account ${acct.name} config_dir`, () => {
      if (!existsSync(acct.config_dir)) throw new Error(`${acct.config_dir} not found`);
      accessSync(acct.config_dir, constants.W_OK);
      return acct.config_dir;
    }));
  }

  // Statusline dir
  checks.push(check('Statusline directory readable', () => {
    if (!existsSync(config.statusline.directory)) throw new Error(`${config.statusline.directory} not found`);
    return config.statusline.directory;
  }));

  printResults(checks);
  const failed = checks.filter((c) => !c.ok);
  if (failed.length > 0) process.exit(1);
}

function printResults(checks: Check[]): void {
  for (const c of checks) {
    const icon = c.ok ? '✓' : '✗';
    const detail = c.detail ? ` — ${c.detail}` : '';
    console.log(`  ${icon} ${c.label}${detail}`);
  }
}
