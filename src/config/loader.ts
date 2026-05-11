import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, accessSync, constants } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import yaml from 'js-yaml';
import type { AisupConfig, AccountConfig } from './schema.js';
import { CONFIG_DEFAULTS } from './defaults.js';

const DEFAULT_CONFIG_PATH = join(homedir(), '.aisup', 'config.yaml');

const PLACEHOLDER_ACCOUNTS_YAML = `accounts:
  - name: primary
    config_dir: ~/.claude
    priority: 1
    enabled: true
  - name: account2
    config_dir: ~/.claude-account2
    priority: 2
    enabled: true
`;

let cachedConfig: AisupConfig | null = null;
let cachedPath: string | null = null;

export function resetConfigCache(): void {
  cachedConfig = null;
  cachedPath = null;
}

function expandPath(p: string): string {
  if (p.startsWith('~/')) {
    return join(homedir(), p.slice(2));
  }
  if (p === '~') {
    return homedir();
  }
  return p;
}

function validatePath(p: string, fieldName: string): string {
  if (p.includes('\x00')) {
    throw new Error(`Invalid path for ${fieldName}: contains NUL byte`);
  }
  if (p.includes('\n')) {
    throw new Error(`Invalid path for ${fieldName}: contains newline`);
  }
  const expanded = expandPath(p);
  if (!isAbsolute(expanded)) {
    throw new Error(`Invalid path for ${fieldName}: must be absolute after expansion, got "${expanded}"`);
  }
  return expanded;
}

function validateExistingDir(p: string, fieldName: string): string {
  const expanded = validatePath(p, fieldName);
  try {
    const st = statSync(expanded);
    if (!st.isDirectory()) {
      throw new Error(`Config validation error: ${fieldName} is not a directory: ${expanded}`);
    }
    accessSync(expanded, constants.R_OK);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('Config validation error')) throw err;
    throw new Error(`Config validation error: ${fieldName} not found or not readable: ${expanded}`);
  }
  return expanded;
}

function mergeDeep<T extends object>(target: T, source: Partial<T>): T {
  const result = { ...target };
  for (const key of Object.keys(source) as (keyof T)[]) {
    const srcVal = source[key];
    const tgtVal = target[key];
    if (srcVal !== undefined) {
      if (
        srcVal !== null &&
        typeof srcVal === 'object' &&
        !Array.isArray(srcVal) &&
        tgtVal !== null &&
        typeof tgtVal === 'object' &&
        !Array.isArray(tgtVal)
      ) {
        result[key] = mergeDeep(tgtVal as object, srcVal as object) as T[keyof T];
      } else {
        result[key] = srcVal as T[keyof T];
      }
    }
  }
  return result;
}

function validateConfig(raw: Record<string, unknown>): AisupConfig {
  // accounts
  const rawAccounts = raw['accounts'];
  if (!Array.isArray(rawAccounts) || rawAccounts.length === 0) {
    throw new Error('Config validation error: accounts must be a non-empty array');
  }

  const accounts: AccountConfig[] = rawAccounts.map((a: unknown, i: number) => {
    if (!a || typeof a !== 'object') {
      throw new Error(`Config validation error: accounts[${i}] must be an object`);
    }
    const acct = a as Record<string, unknown>;

    const name = String(acct['name'] ?? '');
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      throw new Error(
        `Config validation error: account name "${name}" is invalid — only [a-zA-Z0-9_-] allowed`
      );
    }

    const rawDir = String(acct['config_dir'] ?? '');
    const config_dir = validateExistingDir(rawDir, `accounts[${i}].config_dir`);

    return {
      name,
      config_dir,
      priority: typeof acct['priority'] === 'number' ? acct['priority'] : 1,
      enabled: acct['enabled'] !== false,
    };
  });

  // merge with defaults
  const merged = mergeDeep(CONFIG_DEFAULTS, raw as Partial<typeof CONFIG_DEFAULTS>);

  // validate thresholds
  const { soft_pct, hard_pct } = merged.thresholds;
  if (soft_pct < 0 || soft_pct > 100) {
    throw new Error(`Config validation error: thresholds.soft_pct must be 0-100, got ${soft_pct}`);
  }
  if (hard_pct < 0 || hard_pct > 100) {
    throw new Error(`Config validation error: thresholds.hard_pct must be 0-100, got ${hard_pct}`);
  }

  // validate port
  const { port } = merged.daemon;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Config validation error: daemon.port must be 1-65535, got ${port}`);
  }

  // expand paths in journal
  const journalPath = validatePath(merged.journal.path, 'journal.path');
  const statuslineDirectory = validatePath(merged.statusline.directory, 'statusline.directory');

  if (merged.slack.enabled) {
    if (!merged.slack.bot_token_env || !merged.slack.app_token_env) {
      throw new Error('Config validation error: slack bot_token_env and app_token_env are required when Slack is enabled');
    }
    if (!Array.isArray(merged.slack.allowed_user_ids) || merged.slack.allowed_user_ids.length === 0) {
      throw new Error('Config validation error: slack.allowed_user_ids must be non-empty when Slack is enabled');
    }
  }

  return {
    accounts,
    runner: merged.runner,
    thresholds: merged.thresholds,
    failover: merged.failover,
    skills: merged.skills,
    monitoring: merged.monitoring,
    session: merged.session,
    slack: merged.slack,
    daemon: merged.daemon,
    statusline: { ...merged.statusline, directory: statuslineDirectory },
    journal: { path: journalPath },
  };
}

function ensureAisupDir(): void {
  const dir = join(homedir(), '.aisup');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

export async function loadConfig(configPath?: string): Promise<AisupConfig> {
  const resolvedPath = configPath ?? DEFAULT_CONFIG_PATH;

  if (cachedConfig && cachedPath === resolvedPath) {
    return cachedConfig;
  }

  ensureAisupDir();

  let raw: Record<string, unknown>;

  if (!existsSync(resolvedPath)) {
    const dir = resolvedPath.substring(0, resolvedPath.lastIndexOf('/'));
    if (dir) mkdirSync(dir, { recursive: true, mode: 0o700 });
    mkdirSync(join(homedir(), '.claude'), { recursive: true, mode: 0o700 });
    mkdirSync(join(homedir(), '.claude-account2'), { recursive: true, mode: 0o700 });
    writeFileSync(resolvedPath, PLACEHOLDER_ACCOUNTS_YAML, { mode: 0o600 });
    raw = yaml.load(PLACEHOLDER_ACCOUNTS_YAML) as Record<string, unknown>;
  } else {
    const content = readFileSync(resolvedPath, 'utf8');
    const parsed = yaml.load(content);
    if (!parsed || typeof parsed !== 'object') {
      throw new Error(`Config file at ${resolvedPath} is empty or not a valid YAML mapping`);
    }
    raw = parsed as Record<string, unknown>;
  }

  const config = validateConfig(raw);

  cachedConfig = config;
  cachedPath = resolvedPath;

  return config;
}
