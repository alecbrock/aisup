export interface AccountConfig {
  name: string;
  config_dir: string;
  priority: number;
  enabled: boolean;
}

export interface RunnerConfig {
  command: string;
  args: string[];
  resume_flag: string;
  config_dir_env: string;
  remote_control_prefix: string | null;
}

export interface ThresholdsConfig {
  soft_pct: number;
  hard_pct: number;
  idle_boundary_seconds: number;
}

export interface FailoverConfig {
  circuit_breaker_max_failures: number;
  circuit_breaker_cooldown_seconds: number;
}

export interface SkillsConfig {
  tracked: string[];
}

export interface MonitoringConfig {
  rate_limit_interval_s: number;
  health_interval_s: number;
  recovery_interval_s: number;
  idle_interval_s: number;
}

export interface SessionConfig {
  output_log_max_size_mb: number;
  output_log_retention_days: number;
  resume_prompt_mode: 'never' | 'always' | 'on-failure';
}

export interface SlackConfig {
  enabled: boolean;
  bot_token_env: string;
  app_token_env: string;
  allowed_user_ids: string[];
  relay_output_enabled: boolean;
  cmd_require_confirmation: boolean;
  redaction_patterns: string[];
}

export interface DaemonConfig {
  port: number;
  log_max_size_mb: number;
}

export interface StatuslineConfig {
  directory: string;
  freshness_window_s: number;
}

export interface JournalConfig {
  path: string;
}

export interface AisupConfig {
  accounts: AccountConfig[];
  runner: RunnerConfig;
  thresholds: ThresholdsConfig;
  failover: FailoverConfig;
  skills: SkillsConfig;
  monitoring: MonitoringConfig;
  session: SessionConfig;
  slack: SlackConfig;
  daemon: DaemonConfig;
  statusline: StatuslineConfig;
  journal: JournalConfig;
}
