export type SessionStatus =
  | 'CREATING'
  | 'ACTIVE'
  | 'SWITCH_PENDING_AT_IDLE'
  | 'SWITCHING'
  | 'STOPPING'
  | 'STOPPED'
  | 'EXHAUSTED';

export interface SwitchTx {
  switch_phase: null | 'snapshot' | 'stopping' | 'source_destroyed' | 'migrating' | 'creating' | 'resuming';
  source_account: string;
  target_account: string | null;
  source_tmux_name: string;
  source_tmux_session_id: string | null;
  source_pane_id: string | null;
  target_tmux_name: string | null;
  target_tmux_session_id: string | null;
  target_pane_id: string | null;
  source_transcript_path: string | null;
  source_transcript_sha256: string | null;
  source_destroyed: boolean;
  tried_accounts: string[];
  phase_timestamps: Record<string, string>;
  error_summary: string | null;
}

export interface SessionState {
  aisup_session_id: string;
  status: SessionStatus;
  account: string;
  tmux_name: string;
  tmux_session_id: string | null;
  pane_id: string | null;
  cwd: string;
  launch_started_at: string;
  claude_session_id: string | null;
  transcript_path: string | null;
  plan_path: string | null;
  active_skill: string | null;
  output_log_path: string;
  switch_tx: SwitchTx | null;
  created_at: string;
  updated_at: string;
}

export interface SessionInfo {
  status: SessionStatus;
  aisup_session_id?: string;
  hasTmux?: boolean;
}

export type StartAllowedResult =
  | { allowed: true }
  | { allowed: false; reason: string };
