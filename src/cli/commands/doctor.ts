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

  // tmux pane_pipe capability
  checks.push(check('tmux pipe-pane capable', () => {
    const testSocket = 'aisup-doctor-probe';
    try {
      execFileSync('tmux', ['-L', testSocket, 'new-session', '-d', '-s', 'probe', '/bin/sh'], { timeout: 5000 });
      const pipeVal = execFileSync('tmux', ['-L', testSocket, 'display-message', '-p', '-t', 'probe', '#{pane_pipe}'], { encoding: 'utf8', timeout: 5000 }).trim();
      execFileSync('tmux', ['-L', testSocket, 'kill-session', '-t', 'probe'], { timeout: 5000 });
      if (pipeVal !== '0' && pipeVal !== '1') throw new Error(`unexpected pane_pipe value: ${pipeVal}`);
      return 'pipe-pane supported';
    } catch (e) {
      try { execFileSync('tmux', ['-L', testSocket, 'kill-server'], { timeout: 3000 }); } catch { /* ok */ }
      throw e;
    }
  }));

  // Port availability
  checks.push(check(`Daemon port ${config.daemon.port} available`, () => {
    try {
      const out = execFileSync('lsof', ['-i', `:${config.daemon.port}`, '-t'], { encoding: 'utf8', timeout: 5000 }).trim();
      if (out) throw new Error(`port ${config.daemon.port} in use by PID ${out.split('\n')[0]}`);
    } catch (e: unknown) {
      if ((e as { status?: number }).status === 1) return 'port free';
      throw e;
    }
    return 'port free';
  }));

  // Statusline dir
  checks.push(check('Statusline directory readable', () => {
    if (!existsSync(config.statusline.directory)) throw new Error(`${config.statusline.directory} not found`);
    return config.statusline.directory;
  }));

  // Slack prerequisites (when enabled)
  if (config.slack.enabled) {
    checks.push(check('Slack bot token configured', () => {
      const token = process.env[config.slack.bot_token_env];
      if (!token) throw new Error(`env var ${config.slack.bot_token_env} not set`);
      return 'set';
    }));
    checks.push(check('Slack app token configured', () => {
      const token = process.env[config.slack.app_token_env];
      if (!token) throw new Error(`env var ${config.slack.app_token_env} not set`);
      return 'set';
    }));
  }

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
