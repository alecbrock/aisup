import type { AisupConfig } from './schema.js';

export const CONFIG_DEFAULTS: Omit<AisupConfig, 'accounts'> = {
  runner: {
    command: 'pilot',
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
};
