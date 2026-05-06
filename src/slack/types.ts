export interface SlackConfig {
  enabled: boolean;
  bot_token_env: string;
  app_token_env: string;
  allowed_user_ids: string[];
  relay_output_enabled: boolean;
  cmd_require_confirmation: boolean;
  redaction_patterns: string[];
}

export interface ChannelMap {
  [aisupSessionId: string]: string; // channelId
}

export interface PendingConfirmation {
  action: 'stop' | 'cmd';
  payload: string;
  userId: string;
  channelId: string;
  expiresAt: number;
}
