export interface RateLimitWindow {
  used_percentage: number;
  resets_at: number; // Unix epoch seconds
}

export interface StatuslineTelemetry {
  session_id: string;
  transcript_path: string;
  rate_limits?: {
    five_hour?: RateLimitWindow;
    seven_day?: RateLimitWindow;
  };
  cwd?: string;
  model?: { id?: string; display_name?: string };
  context_window?: { used_percentage?: number; context_window_size?: number };
  cost?: { total_cost_usd?: number };
  session_name?: string;
  version?: string;
}

export interface TelemetryFile {
  name: string;
  path: string;
  mtime: Date;
  stale: boolean;
}

export interface SessionMismatch {
  reason: string;
  claudeSessionId: string;
  observedTranscriptPath?: string;
  observedSessionId?: string;
}
