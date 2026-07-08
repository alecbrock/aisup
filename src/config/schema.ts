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
  /** Optional early-warning band (A8): when usage crosses this % (below soft) a single Slack alert
   *  is pushed. Absent = no warning band. */
  warning_pct?: number;
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
  /** Keystroke for Claude's "don't ask again / approve for this session" dialog option. Absent until
   *  observed against the running Claude (A0) — when unset the Slack card ships Approve/Deny only and
   *  the "Approve for session" button is hidden (never guess the keystroke). */
  approval_session_key?: string;
  policy: PermissionPolicyConfig;
  slack_routing: boolean;
  /** Legacy fallback-broker expiry bound. `null`/absent = never expire (the default — a human may
   *  take hours); a finite `N > 0` expires a Slack-routed request after N seconds. `0` is NOT a
   *  sentinel and never expires. The hook (Slack-button) path has no timer regardless. */
  grant_ttl_seconds: number | null;
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
  /** Operator asserts the Slack app's Interactivity toggle is ON (required for Block Kit buttons in
   * Socket Mode). Default true; the startup probe journals `slack.interactivity_unverified` when this
   * is false so button routing never fails silently. `doctor` performs the live scope/toggle check. */
  interactivity_enabled: boolean;
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
  /** Rotate the journal when it exceeds this size in MB (D3). 0/absent = no rotation. */
  max_size_mb?: number;
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
  /** F-4 opt-in: when true, a `security_denied` task's persisted prompt/title are replaced with
   *  placeholders (the operator's input may carry secrets and a denied task is never retried).
   *  Default false — today's behavior (input retained, 0600-isolated) is intentional. */
  redact_denied_prompts?: boolean;
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
  notifications: NotificationsConfig;
  daemon: DaemonConfig;
  statusline: StatuslineConfig;
  journal: JournalConfig;
  workers: WorkersConfig;
  roles: RolesConfig;
}

export interface NtfyConfig {
  /** When true, key push-worthy events are mirrored to the ntfy topic (D2). */
  enabled: boolean;
  /** ntfy topic name (the path after the server). */
  topic: string;
  /** ntfy server base URL, e.g. https://ntfy.sh. */
  server: string;
}

export interface NotificationsConfig {
  /** Default activity-feed verbosity: `silent` (feed off; cards/alerts still post), `normal`
   *  (meaningful actions), `verbose` (all tool uses). Overridable per channel via `!notify`. */
  verbosity: 'silent' | 'normal' | 'verbose';
  /** Optional ntfy push fallback (notification-only; Slack remains the control plane) — D2. */
  ntfy?: NtfyConfig;
}
