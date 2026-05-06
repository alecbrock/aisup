const BUILTIN_PATTERNS: RegExp[] = [
  /sk-[a-zA-Z0-9]{20,}/g,
  /xoxb-[a-zA-Z0-9-]+/g,
  /token[=:]\s*\S+/gi,
  /Authorization:\s*Bearer\s+\S+/gi,
  /export\s+\w*(SECRET|KEY|TOKEN|PASSWORD)\w*=\S+/gi,
];

export function redactSecrets(text: string, extraPatterns: RegExp[]): string {
  if (!text) return text;
  let result = text;
  for (const pattern of [...BUILTIN_PATTERNS, ...extraPatterns]) {
    result = result.replace(pattern, '[REDACTED]');
  }
  return result;
}

export function isAllowedUser(userId: string, allowedIds: string[]): boolean {
  return allowedIds.includes(userId);
}

export function isBotMessage(event: { subtype?: string; bot_id?: string }): boolean {
  return (
    event.subtype === 'bot_message' ||
    event.subtype === 'message_changed' ||
    event.subtype === 'message_deleted' ||
    event.subtype === 'channel_join' ||
    event.subtype === 'channel_leave' ||
    !!event.bot_id
  );
}

export interface RelayMessage {
  text: string;
  userId: string;
  channelId: string;
  ts: string;
}
