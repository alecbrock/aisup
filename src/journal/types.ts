export type EventType =
  // Session
  | 'session.start'
  | 'session.stop'
  | 'session.attach'
  | 'session.destroyed_externally'
  | 'session.exhausted'
  // Account
  | 'account.switch'
  // Runner lifecycle
  | 'runner.terminated_for_switch'
  | 'runner.launch_failed'
  | 'runner.respawn_failed'
  // Failure/Recovery
  | 'failure.detected'
  | 'recovery.success'
  | 'recovery.failed'
  | 'recovery.restart_same_account'
  | 'recovery.restart_fresh_no_session_id'
  // Circuit breaker
  | 'circuit_breaker.tripped'
  | 'circuit_breaker.reset'
  // Rate limit
  | 'rate_limit.threshold_crossed'
  // Failover
  | 'failover.skipped_concurrent'
  | 'failover.target_invalid'
  | 'failover.target_unavailable'
  | 'failover.target_is_current'
  | 'failover.no_target_available'
  // Migration
  | 'migration.started'
  | 'migration.completed'
  | 'migration.skipped_no_transcript'
  | 'migration.skipped_already_migrated'
  | 'migration.integrity_mismatch'
  | 'migration.collision_renamed'
  | 'migration.invalid_path'
  | 'migration.path_traversal_rejected'
  // Skill
  | 'skill.detected'
  | 'skill.transition'
  // Daemon
  | 'daemon.started'
  | 'daemon.stopped'
  | 'daemon.rehydrated'
  | 'daemon.ready'
  // Telemetry
  | 'telemetry.stale_warning'
  | 'telemetry.invalid_json'
  | 'telemetry.session_mismatch'
  // Slack
  | 'slack.channel_created'
  | 'slack.channel_name_collision'
  | 'slack.connection_error'
  | 'slack.queue_dropped'
  | 'slack.rate_limited'
  | 'slack.message_ignored'
  // tmux
  | 'tmux.command_timeout'
  // Output log
  | 'output_log.rotated'
  | 'output_log.cursor_reset';

export interface JournalEvent {
  ts: string;
  event_type: EventType;
  aisup_session_id?: string;
  claude_session_id?: string;
  account?: string;
  details: Record<string, unknown>;
  tokens?: number;
  cost_usd?: number;
}

export interface ReadEventsOptions {
  since?: string;
  type?: EventType | string;
  limit?: number;
}

export interface JournalWriter {
  append(event: JournalEvent): Promise<void>;
}
