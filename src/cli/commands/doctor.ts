import { execFileSync } from 'node:child_process';
import { existsSync, accessSync, constants, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { loadConfig } from '../../config/loader.js';
import { validateRunner } from '../../runner/builder.js';
import { readTelemetryForAccount } from '../../statusline/store.js';

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
    checks.push(check(`Account ${acct.name} statusline command`, () => {
      const settingsPath = join(acct.config_dir, 'settings.json');
      if (!existsSync(settingsPath)) return 'no settings.json';
      const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as { statusLine?: { command?: string } };
      const command = settings.statusLine?.command;
      if (!command) return 'not configured';
      const words = splitShellWords(command);
      if (words.length === 0) throw new Error('empty statusLine.command');
      const executable = statuslineExecutable(words);
      if (!executable.includes('/')) return executable;
      if (!existsSync(executable)) throw new Error(`${executable} not found`);
      const st = statSync(executable);
      if (!st.isFile()) throw new Error(`${executable} is not a file`);
      accessSync(executable, constants.R_OK);
      return executable;
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
  printTelemetry(config);
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

function splitShellWords(input: string): string[] {
  const words: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let escaping = false;
  for (const ch of input) {
    if (escaping) {
      current += ch;
      escaping = false;
      continue;
    }
    if (ch === '\\' && quote !== "'") {
      escaping = true;
      continue;
    }
    if ((ch === '"' || ch === "'") && !quote) {
      quote = ch;
      continue;
    }
    if (quote === ch) {
      quote = null;
      continue;
    }
    if (!quote && /\s/.test(ch)) {
      if (current) {
        words.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }
  if (quote) throw new Error('unterminated quote in statusLine.command');
  if (current) words.push(current);
  return words;
}

function statuslineExecutable(words: string[]): string {
  const first = words[0];
  const base = basename(first);
  if (['node', 'bash', 'sh', 'zsh', 'python', 'python3', 'ruby'].includes(base) && words[1]) {
    return words[1];
  }
  return first;
}

function printTelemetry(config: Awaited<ReturnType<typeof loadConfig>>): void {
  console.log('Account | Model | Context Window | Total Cost');
  let anyTelemetry = false;
  for (const acct of config.accounts) {
    const telemetry = readTelemetryForAccount(acct.config_dir, config.statusline.directory, config.statusline.freshness_window_s);
    const model = telemetry?.model?.id ?? '—';
    const contextWindow = telemetry?.context_window?.context_window_size ?? '—';
    const cost = telemetry?.cost?.total_cost_usd ?? '—';
    console.log(`${acct.name} | ${model} | ${contextWindow} | ${cost}`);
    if (telemetry) {
      anyTelemetry = true;
    } else {
      console.log(`  ! ${acct.name}: no telemetry`);
    }
  }
  // F-7: when NO account has telemetry in the configured directory, surface the most common cause —
  // the account statusLine.command tap writes somewhere other than config.statusline.directory, which
  // silently disables claude_session_id / rate-limit % / cost / failover telemetry.
  if (!anyTelemetry) {
    console.log(
      `  ! no telemetry in statusline.directory (${config.statusline.directory}). ` +
      `If a session is active, ensure each account's settings.json statusLine.command writes to this exact directory (F-7).`
    );
  }
}
