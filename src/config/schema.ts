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
  tmux_socket: string;
}

export interface RecoveryConfig {
  auto_resume_exhausted: boolean;
  exhausted_poll_interval_s: number;
  network_error_threshold: number;
  max_exhausted_retries: number;
}

export interface PermissionPolicyConfig {
  allowlist: string[];
  denylist: string[];
  default_action: 'allow' | 'deny';
}

export interface PermissionsConfig {
  enabled: boolean;
  detection_patterns: string[];
  approval_key: string;
  denial_key: string;
  policy: PermissionPolicyConfig;
  slack_routing: boolean;
  grant_ttl_seconds: number;
}

export interface GateCommandConfig {
  name: string;
  command: string;
  args: string[];
  timeout_seconds: number;
  required: boolean;
  cwd: string | null;
}

export interface GatesConfig {
  enabled: boolean;
  gates: GateCommandConfig[];
  trigger: 'idle_and_skill' | 'manual';
  idle_delay_seconds: number;
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

export interface WorkerAdapterConfig {
  name: string;
  command: string;
  args: string[];
  prompt_via: 'arg' | 'stdin' | 'file';
  prompt_arg_flag: string | null;
  prompt_file_flag: string | null;
  env_allowlist: string[];
  timeout_seconds: number;
  enabled: boolean;
  /** Stdout format. 'json' (codex `--json` stream) routes output through the codex-json parser before verdict/usage extraction. Absent ⇒ 'text'. */
  output_format?: 'text' | 'json';
}

export interface WorkerRouteOverride {
  implementer: string;
  reviewer: string;
}

export interface WorkerRoutingConfig {
  default_implementer: string;
  default_reviewer: string;
  by_task_type: Record<string, WorkerRouteOverride>;
}

export interface WorkerReviewConfig {
  allow_same_model_review: boolean;
}

export interface WorkerValidationConfig {
  allow_no_validation: boolean;
}

export interface WorkerRetentionConfig {
  keep_merged: boolean;
  keep_rejected: boolean;
  max_age_hours: number;
}

export interface WorkerSecurityConfig {
  env_allowlist: string[];
  boundary_audit: boolean;
  forbidden_path_globs: string[];
}

export interface WorkerMergeConfig {
  require_approval: boolean;
  apply_check_required: boolean;
}

/** Rolling token budget for a metered provider (codex). Crossing `tokens` within `period_hours` marks it UNAVAILABLE. */
export interface CodexBudgetConfig {
  tokens: number;
  period_hours: number;
}

/** One candidate in a role's ordered failover list. `provider` is 'claude' (account auto-selected) or a defined adapter name. */
export interface RoleCandidateConfig {
  provider: string;
  model: string | null;
  effort: string | null;
  budget: CodexBudgetConfig | null;
}

/** Ordered provider/account candidate lists per worker role. Account-first ordering is applied at selection time. */
export interface RolesConfig {
  implementer: RoleCandidateConfig[];
  reviewer: RoleCandidateConfig[];
  orchestrator: RoleCandidateConfig[];
}

export interface WorkersConfig {
  enabled: boolean;
  workspace_root: string | null;
  worktree_dir: string;
  base_ref: string;
  max_concurrent: number;
  retention: WorkerRetentionConfig;
  security: WorkerSecurityConfig;
  adapters: Record<string, WorkerAdapterConfig>;
  routing: WorkerRoutingConfig;
  review: WorkerReviewConfig;
  validation_gates: GateCommandConfig[];
  validation: WorkerValidationConfig;
  merge: WorkerMergeConfig;
}

export interface AisupConfig {
  accounts: AccountConfig[];
  runner: RunnerConfig;
  thresholds: ThresholdsConfig;
  failover: FailoverConfig;
  skills: SkillsConfig;
  monitoring: MonitoringConfig;
  session: SessionConfig;
  recovery: RecoveryConfig;
  permissions: PermissionsConfig;
  gates: GatesConfig;
  slack: SlackConfig;
  daemon: DaemonConfig;
  statusline: StatuslineConfig;
  journal: JournalConfig;
  workers: WorkersConfig;
  roles: RolesConfig;
}
