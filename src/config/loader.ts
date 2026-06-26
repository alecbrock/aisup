import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, accessSync, constants } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import yaml from 'js-yaml';
import type { AisupConfig, AccountConfig, GateCommandConfig, WorkersConfig, WorkerAdapterConfig, RolesConfig, RoleCandidateConfig, CodexBudgetConfig } from './schema.js';
import { CONFIG_DEFAULTS } from './defaults.js';
import { aisupHome } from './paths.js';

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

function validateTmuxSocket(socket: string): string {
  if (!socket || !/^[A-Za-z0-9._-]+$/.test(socket)) {
    throw new Error(
      `Config validation error: session.tmux_socket must be a non-empty name using only [A-Za-z0-9._-] (no whitespace, path separators, or control characters), got "${socket}"`
    );
  }
  return socket;
}

function validateKeyInput(key: string, fieldName: string): string {
  // A permission keystroke is sent verbatim to the tmux dialog (AF-306): it must be exactly ONE
  // printable ASCII character. Multi-char ("yes") or multi-byte (emoji) values silently fail to
  // resolve the dialog, so reject them loudly at load.
  if (!/^[\x20-\x7e]$/.test(key)) {
    throw new Error(
      `Config validation error: ${fieldName} must be a single printable ASCII character (one keystroke)`
    );
  }
  return key;
}

function validateGates(gates: GateCommandConfig[]): GateCommandConfig[] {
  if (!Array.isArray(gates)) {
    throw new Error('Config validation error: gates.gates must be an array');
  }
  gates.forEach((g, i) => {
    if (!g || typeof g !== 'object') {
      throw new Error(`Config validation error: gates.gates[${i}] must be an object`);
    }
    if (!g.name || typeof g.name !== 'string') {
      throw new Error(`Config validation error: gates.gates[${i}].name must be a non-empty string`);
    }
    if (!g.command || typeof g.command !== 'string' || /\s/.test(g.command)) {
      throw new Error(
        `Config validation error: gates.gates[${i}].command must be an executable with no embedded arguments — put arguments in args`
      );
    }
    if (!Array.isArray(g.args)) {
      throw new Error(`Config validation error: gates.gates[${i}].args must be an array`);
    }
  });
  return gates;
}

const ENV_VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function validateWorkerAdapter(name: string, raw: WorkerAdapterConfig): WorkerAdapterConfig {
  const a = { ...raw, name };
  const prefix = `workers.adapters.${name}`;
  if (typeof a.command !== 'string') {
    throw new Error(`Config validation error: ${prefix}.command must be a string`);
  }
  // Empty command allowed only for a disabled adapter (operator-provided placeholder).
  if (a.command === '') {
    if (a.enabled) {
      throw new Error(`Config validation error: ${prefix}.command must be set when the adapter is enabled`);
    }
  } else if (/\s/.test(a.command)) {
    throw new Error(
      `Config validation error: ${prefix}.command must be an executable with no embedded arguments — put arguments in args`
    );
  }
  if (!Array.isArray(a.args)) {
    throw new Error(`Config validation error: ${prefix}.args must be an array`);
  }
  if (a.prompt_via !== 'arg' && a.prompt_via !== 'stdin' && a.prompt_via !== 'file') {
    throw new Error(`Config validation error: ${prefix}.prompt_via must be one of arg|stdin|file`);
  }
  if (!Number.isInteger(a.timeout_seconds) || a.timeout_seconds <= 0) {
    throw new Error(`Config validation error: ${prefix}.timeout_seconds must be a positive integer`);
  }
  if (!Array.isArray(a.env_allowlist) || !a.env_allowlist.every((e) => typeof e === 'string' && ENV_VAR_NAME.test(e))) {
    throw new Error(`Config validation error: ${prefix}.env_allowlist must be an array of valid env var names`);
  }
  // output_format defaults to 'text'; only codex --json adapters use 'json'.
  if (a.output_format === undefined) {
    a.output_format = 'text';
  } else if (a.output_format !== 'text' && a.output_format !== 'json') {
    throw new Error(`Config validation error: ${prefix}.output_format must be one of text|json`);
  }
  return a;
}

function validateWorkers(workers: WorkersConfig): WorkersConfig {
  // merge.require_approval and security.boundary_audit are unconditional invariants.
  if (workers.merge.require_approval !== true) {
    throw new Error('Config validation error: workers.merge.require_approval must be true (no auto-merge)');
  }
  if (workers.security.boundary_audit !== true) {
    throw new Error('Config validation error: workers.security.boundary_audit must be true');
  }

  // Removed review knobs — reject so an operator never believes fail-open review is enabled.
  const review = workers.review as unknown as Record<string, unknown>;
  if ('parse_failure_verdict' in review) {
    throw new Error(
      'Config validation error: workers.review.parse_failure_verdict was removed — parse failure always rejects (fail-closed)'
    );
  }
  if ('require_cross_model' in review) {
    throw new Error(
      'Config validation error: workers.review.require_cross_model was removed — use review.allow_same_model_review'
    );
  }
  if (typeof workers.review.allow_same_model_review !== 'boolean') {
    throw new Error('Config validation error: workers.review.allow_same_model_review must be a boolean');
  }

  // base_ref argument-injection guard.
  if (typeof workers.base_ref !== 'string' || workers.base_ref === '' || workers.base_ref.startsWith('-')) {
    throw new Error('Config validation error: workers.base_ref must be a non-empty git ref not beginning with "-"');
  }

  // worktree_dir static safety (relative, no .. / leading slash / reserved segments).
  const wd = workers.worktree_dir;
  if (typeof wd !== 'string' || wd === '') {
    throw new Error('Config validation error: workers.worktree_dir must be a non-empty relative path');
  }
  if (isAbsolute(wd) || wd.startsWith('/')) {
    throw new Error('Config validation error: workers.worktree_dir must be relative (no leading "/")');
  }
  const segments = wd.split('/');
  if (wd === '.' || segments.includes('..') || segments.includes('.git')) {
    throw new Error('Config validation error: workers.worktree_dir must not be ".", contain "..", or contain a ".git" segment');
  }

  // workspace_root, when set, must be an existing directory; == worktree_dir guard.
  let workspaceRoot: string | null = null;
  if (workers.workspace_root !== null && workers.workspace_root !== undefined) {
    workspaceRoot = validateExistingDir(String(workers.workspace_root), 'workers.workspace_root');
    if (join(workspaceRoot, wd) === workspaceRoot) {
      throw new Error('Config validation error: workers.worktree_dir must not resolve to workspace_root');
    }
  }

  if (!Number.isInteger(workers.max_concurrent) || workers.max_concurrent < 1) {
    throw new Error('Config validation error: workers.max_concurrent must be a positive integer');
  }

  // Adapters: inject name from key, validate each.
  if (!workers.adapters || typeof workers.adapters !== 'object') {
    throw new Error('Config validation error: workers.adapters must be an object');
  }
  const adapters: Record<string, WorkerAdapterConfig> = {};
  for (const [key, raw] of Object.entries(workers.adapters)) {
    adapters[key] = validateWorkerAdapter(key, raw);
  }
  const adapterNames = Object.keys(adapters);
  const isDefined = (n: string): boolean => adapterNames.includes(n);
  const isEnabled = (n: string): boolean => adapters[n]?.enabled === true;

  // Routing: referenced adapters must be defined; reviewer/implementer enablement gated on enabled.
  const routing = workers.routing;
  if (!isDefined(routing.default_implementer)) {
    throw new Error(`Config validation error: workers.routing.default_implementer "${routing.default_implementer}" is not a defined adapter`);
  }
  if (!isDefined(routing.default_reviewer)) {
    throw new Error(`Config validation error: workers.routing.default_reviewer "${routing.default_reviewer}" is not a defined adapter`);
  }
  for (const [taskType, override] of Object.entries(routing.by_task_type ?? {})) {
    if (!isDefined(override.implementer)) {
      throw new Error(`Config validation error: workers.routing.by_task_type.${taskType}.implementer "${override.implementer}" is not a defined adapter`);
    }
    if (!isDefined(override.reviewer)) {
      throw new Error(`Config validation error: workers.routing.by_task_type.${taskType}.reviewer "${override.reviewer}" is not a defined adapter`);
    }
  }

  // validation_gates: reuse gate validator + worker-specific cwd-must-be-null rule.
  validateGates(workers.validation_gates);
  workers.validation_gates.forEach((g, i) => {
    if (g.cwd !== null && g.cwd !== undefined) {
      throw new Error(`Config validation error: workers.validation_gates[${i}].cwd must be null/omitted — worker gates always run against the worktree`);
    }
  });

  if (workers.enabled) {
    if (!adapterNames.some((n) => isEnabled(n))) {
      throw new Error('Config validation error: workers.enabled requires at least one enabled adapter');
    }
    if (!isEnabled(routing.default_implementer)) {
      throw new Error(`Config validation error: workers.routing.default_implementer "${routing.default_implementer}" must name an enabled adapter`);
    }
    for (const [taskType, override] of Object.entries(routing.by_task_type ?? {})) {
      if (isDefined(override.reviewer) && !isEnabled(override.reviewer)) {
        throw new Error(`Config validation error: workers.routing.by_task_type.${taskType}.reviewer "${override.reviewer}" names a disabled adapter`);
      }
    }
    if (!workers.validation.allow_no_validation && !workers.validation_gates.some((g) => g.required === true)) {
      throw new Error(
        'Config validation error: workers.enabled requires at least one required validation gate (or set workers.validation.allow_no_validation: true)'
      );
    }
  }

  return { ...workers, workspace_root: workspaceRoot, worktree_dir: wd, adapters };
}

/**
 * Resolve `roles` (Part B). Explicit `roles:` block → validated; absent → synthesized as one-candidate
 * lists from `workers.routing` (back-compat). Every candidate provider must be 'claude' (requires an
 * enabled account) or a DEFINED adapter; budgets must be positive integers; implementer/reviewer must
 * be non-empty when workers are enabled.
 */
function validateRoles(
  raw: Record<string, unknown>,
  workers: WorkersConfig,
  accounts: AccountConfig[]
): RolesConfig {
  const adapterNames = new Set(Object.keys(workers.adapters));
  const hasEnabledAccount = accounts.some((a) => a.enabled);

  const validateBudget = (b: unknown, where: string): CodexBudgetConfig | null => {
    if (b === null || b === undefined) return null;
    if (typeof b !== 'object') throw new Error(`Config validation error: ${where}.budget must be an object`);
    const { tokens, period_hours } = b as Record<string, unknown>;
    if (!Number.isInteger(tokens) || (tokens as number) <= 0) {
      throw new Error(`Config validation error: ${where}.budget.tokens must be a positive integer`);
    }
    if (!Number.isInteger(period_hours) || (period_hours as number) <= 0) {
      throw new Error(`Config validation error: ${where}.budget.period_hours must be a positive integer`);
    }
    return { tokens: tokens as number, period_hours: period_hours as number };
  };

  const validateCandidate = (c: unknown, where: string): RoleCandidateConfig => {
    if (!c || typeof c !== 'object') throw new Error(`Config validation error: ${where} must be an object`);
    const cand = c as Record<string, unknown>;
    const provider = cand['provider'];
    if (typeof provider !== 'string' || provider === '') {
      throw new Error(`Config validation error: ${where}.provider must be a non-empty string`);
    }
    if (provider !== 'claude' && !adapterNames.has(provider)) {
      throw new Error(`Config validation error: ${where}.provider "${provider}" is not 'claude' or a defined adapter`);
    }
    if (provider === 'claude' && !hasEnabledAccount) {
      throw new Error(`Config validation error: ${where}.provider 'claude' requires at least one enabled account`);
    }
    return {
      provider,
      model: typeof cand['model'] === 'string' ? (cand['model'] as string) : null,
      effort: typeof cand['effort'] === 'string' ? (cand['effort'] as string) : null,
      budget: validateBudget(cand['budget'], where),
    };
  };

  const validateList = (list: unknown, role: string): RoleCandidateConfig[] => {
    if (!Array.isArray(list)) throw new Error(`Config validation error: roles.${role} must be an array of candidates`);
    if (workers.enabled && list.length === 0) {
      throw new Error(`Config validation error: roles.${role} must be a non-empty candidate list when workers are enabled`);
    }
    return list.map((c, i) => validateCandidate(c, `roles.${role}[${i}]`));
  };

  const single = (provider: string): RoleCandidateConfig[] => [{ provider, model: null, effort: null, budget: null }];

  const rawRoles = raw['roles'];
  if (rawRoles !== undefined && rawRoles !== null) {
    if (typeof rawRoles !== 'object') throw new Error('Config validation error: roles must be an object');
    const r = rawRoles as Record<string, unknown>;
    return {
      implementer: validateList(r['implementer'], 'implementer'),
      reviewer: validateList(r['reviewer'], 'reviewer'),
      orchestrator: r['orchestrator'] !== undefined && r['orchestrator'] !== null
        ? validateList(r['orchestrator'], 'orchestrator')
        : single('claude'),
    };
  }

  // Back-compat synthesis from workers.routing (validated to name defined adapters above).
  const di = workers.routing.default_implementer;
  const dr = workers.routing.default_reviewer;
  if (workers.enabled && (!di || !dr)) {
    throw new Error('Config validation error: workers.enabled requires either a roles config or workers.routing');
  }
  return {
    implementer: validateList(single(di), 'implementer'),
    reviewer: validateList(single(dr), 'reviewer'),
    orchestrator: single('claude'),
  };
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
  // soft must be strictly below hard, else the DEGRADED (proactive-failover) band is empty or the
  // semantics invert (AF-315).
  if (soft_pct >= hard_pct) {
    throw new Error(
      `Config validation error: thresholds.soft_pct (${soft_pct}) must be less than thresholds.hard_pct (${hard_pct})`
    );
  }

  // statusline freshness window: a negative value makes ALL telemetry appear stale (AF-320).
  const freshness = merged.statusline.freshness_window_s;
  if (typeof freshness !== 'number' || !Number.isFinite(freshness) || freshness < 0) {
    throw new Error(`Config validation error: statusline.freshness_window_s must be a non-negative number, got ${freshness}`);
  }

  // validate port
  const { port } = merged.daemon;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Config validation error: daemon.port must be 1-65535, got ${port}`);
  }

  // journal.path is config-driven (default '~/.aisup/journal.jsonl'); when the operator does NOT
  // override it, resolve the default through aisupHome() so AISUP_HOME relocates the journal — the
  // generic join-site routing cannot reach this config default (review 2026-06-23 CR-001). Unset
  // AISUP_HOME ⇒ identical to expanding '~/.aisup/journal.jsonl' (no behavior change).
  const rawJournal = raw['journal'];
  const journalOverridden =
    !!rawJournal && typeof rawJournal === 'object' && (rawJournal as Record<string, unknown>)['path'] != null;
  const journalRaw = journalOverridden ? merged.journal.path : join(aisupHome(), 'journal.jsonl');
  const journalPath = validatePath(journalRaw, 'journal.path');
  // statusline.directory is shared statusline-tap telemetry INPUT — intentionally NOT relocated by AISUP_HOME.
  const statuslineDirectory = validatePath(merged.statusline.directory, 'statusline.directory');

  // Phase 2 contract baseline: tmux socket, permission keystrokes, gate commands.
  const tmuxSocket = validateTmuxSocket(merged.session.tmux_socket);
  validateKeyInput(merged.permissions.approval_key, 'permissions.approval_key');
  validateKeyInput(merged.permissions.denial_key, 'permissions.denial_key');
  if (!Number.isInteger(merged.recovery.max_exhausted_retries) || merged.recovery.max_exhausted_retries < 0) {
    throw new Error('Config validation error: recovery.max_exhausted_retries must be a non-negative integer');
  }
  if (!Number.isInteger(merged.recovery.exhausted_poll_interval_s) || merged.recovery.exhausted_poll_interval_s < 1) {
    throw new Error('Config validation error: recovery.exhausted_poll_interval_s must be a positive integer');
  }
  validateGates(merged.gates.gates);
  const workers = validateWorkers(merged.workers);
  const roles = validateRoles(raw, workers, accounts);

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
    session: { ...merged.session, tmux_socket: tmuxSocket },
    recovery: merged.recovery,
    permissions: merged.permissions,
    gates: merged.gates,
    slack: merged.slack,
    daemon: merged.daemon,
    statusline: { ...merged.statusline, directory: statuslineDirectory },
    journal: { path: journalPath },
    workers,
    roles,
  };
}

function ensureAisupDir(): void {
  const dir = aisupHome();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

export async function loadConfig(configPath?: string): Promise<AisupConfig> {
  // Computed at call time (not a module const) so AISUP_HOME set by tests/live-run is honored.
  const resolvedPath = configPath ?? join(aisupHome(), 'config.yaml');

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
