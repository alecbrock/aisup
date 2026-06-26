import type { AisupConfig, CodexBudgetConfig, RolesConfig } from './schema.js';

/**
 * Default codex token budget (starter, tunable to the operator's ChatGPT plan). A codex candidate with
 * no explicit `budget` is metered against this so a codex-default task fails over once it is crossed
 * (Goal Verification Truth 2). ~tens of tasks per 5h before a clean proactive failover (a trivial codex
 * run ≈ 39k tokens, measured 2026-06-19). codex exposes no quota readout, so this is a heuristic.
 */
export const DEFAULT_CODEX_BUDGET: CodexBudgetConfig = { tokens: 3_000_000, period_hours: 5 };

/** The effective codex budget: the first explicit per-candidate `budget` in any role, else the default. */
export function resolveCodexBudget(roles: RolesConfig): CodexBudgetConfig {
  for (const list of [roles.implementer, roles.reviewer, roles.orchestrator]) {
    for (const c of list) {
      if (c.provider !== 'claude' && c.budget) return c.budget;
    }
  }
  return DEFAULT_CODEX_BUDGET;
}

// `roles` is omitted: it is computed by the loader (validateRoles) from an explicit `roles:` block
// or synthesized from `workers.routing` for back-compat — never a static default.
export const CONFIG_DEFAULTS: Omit<AisupConfig, 'accounts' | 'roles'> = {
  runner: {
    // Modern Pilot Shell is hook-integrated into Claude Code (running `pilot` alone just prints a
    // banner and exits), so the runner that actually launches a session is `claude` — Pilot's hooks,
    // skills, and rules load automatically. Set to another CLI to detach.
    command: 'claude',
    args: [],
    resume_flag: '--resume',
    config_dir_env: 'CLAUDE_CONFIG_DIR',
    remote_control_prefix: null,
  },
  thresholds: {
    soft_pct: 85,
    hard_pct: 95,
    idle_boundary_seconds: 30,
  },
  failover: {
    circuit_breaker_max_failures: 3,
    circuit_breaker_cooldown_seconds: 300,
  },
  skills: {
    tracked: ['/prd', '/spec', '/fix', '/review', '/security-review'],
  },
  monitoring: {
    rate_limit_interval_s: 30,
    health_interval_s: 60,
    recovery_interval_s: 5,
    idle_interval_s: 120,
  },
  session: {
    output_log_max_size_mb: 50,
    output_log_retention_days: 7,
    resume_prompt_mode: 'never',
    tmux_socket: 'aisup',
  },
  recovery: {
    auto_resume_exhausted: true,
    exhausted_poll_interval_s: 60,
    network_error_threshold: 3,
    max_exhausted_retries: 5,
  },
  permissions: {
    enabled: false,
    detection_patterns: [],
    approval_key: 'y',
    denial_key: 'n',
    policy: {
      allowlist: [],
      denylist: [],
      default_action: 'deny',
    },
    slack_routing: false,
    grant_ttl_seconds: 300,
  },
  gates: {
    enabled: false,
    gates: [],
    trigger: 'idle_and_skill',
    idle_delay_seconds: 30,
  },
  slack: {
    enabled: false,
    bot_token_env: 'AISUP_SLACK_BOT_TOKEN',
    app_token_env: 'AISUP_SLACK_APP_TOKEN',
    allowed_user_ids: [],
    relay_output_enabled: false,
    cmd_require_confirmation: true,
    redaction_patterns: [],
  },
  daemon: {
    port: 7394,
    log_max_size_mb: 10,
  },
  statusline: {
    directory: '/tmp/pilot-failover',
    freshness_window_s: 300,
  },
  journal: {
    path: '~/.aisup/journal.jsonl',
  },
  workers: {
    enabled: false,
    workspace_root: null,
    worktree_dir: '.aisup-workers',
    base_ref: 'HEAD',
    max_concurrent: 2,
    retention: {
      keep_merged: false,
      keep_rejected: true,
      max_age_hours: 168,
    },
    security: {
      env_allowlist: ['PATH', 'HOME', 'LANG'],
      boundary_audit: true,
      forbidden_path_globs: [
        '**/.claude/settings.local.json',
        '**/.claude/transcripts/**',
        '**/*.jsonl',
        '**/*.tmux-capture',
        '**/*.pem',
        '**/.env',
        '**/.env.*',
      ],
    },
    adapters: {
      codex: {
        name: 'codex',
        command: 'codex',
        // exec = non-interactive run; --json = stream parsed by codex-json (budget meter + reviewer
        // verdict); --skip-git-repo-check = harmless inside a worktree (already a git repo); -s
        // workspace-write = lets the worker actually edit files. Matches the operator's proven config.
        // The workspace boundary is still enforced independently by auditBoundary/sanitizePatch.
        args: ['exec', '--json', '--skip-git-repo-check', '-s', 'workspace-write'],
        prompt_via: 'arg',
        prompt_arg_flag: null,
        prompt_file_flag: null,
        // CODEX_HOME lets the worker reach codex's ChatGPT auth (~/.codex) while HOME is isolated to
        // the worktree — without it, codex looks for ~/.codex under the empty worktree HOME and can't
        // authenticate (the daemon must export CODEX_HOME=~/.codex). Proven by the T3/T4 host-gated runs.
        env_allowlist: ['PATH', 'HOME', 'CODEX_HOME'],
        timeout_seconds: 1800,
        enabled: false,
        output_format: 'json',
      },
      gemini: {
        name: 'gemini',
        command: 'gemini',
        args: [],
        prompt_via: 'arg',
        prompt_arg_flag: null,
        prompt_file_flag: null,
        env_allowlist: ['PATH', 'HOME'],
        timeout_seconds: 1800,
        enabled: false,
      },
      local: {
        name: 'local',
        command: '',
        args: [],
        prompt_via: 'stdin',
        prompt_arg_flag: null,
        prompt_file_flag: null,
        env_allowlist: ['PATH', 'HOME'],
        timeout_seconds: 1800,
        enabled: false,
      },
    },
    // ⚠️ `routing.*` is the BACK-COMPAT path used only when no `roles:` block is configured; it
    // synthesizes one-candidate role lists. It does NOT mean codex runs first: the account-first
    // selector (providers/selector.ts) always orders every enabled Claude account ahead of any codex
    // candidate, so codex is reached only when all Claude accounts are unavailable (AF-207 / AF-R009).
    routing: {
      default_implementer: 'codex',
      default_reviewer: 'gemini',
      by_task_type: {},
    },
    review: {
      allow_same_model_review: false,
    },
    validation_gates: [],
    validation: {
      allow_no_validation: false,
    },
    merge: {
      require_approval: true,
      apply_check_required: true,
    },
  },
};
