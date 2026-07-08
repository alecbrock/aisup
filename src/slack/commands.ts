const KNOWN_COMMANDS = new Set(['interrupt', 'stop', 'status', 'cmd', 'relay', 'help', 'confirm', 'failover', 'permit', 'deny', 'gate', 'worker', 'notify', 'accounts', 'account', 'cost', 'health', 'pause', 'resume']);

export interface ParsedCommand {
  name: string;
  args: string;
}

export function parseCommand(text: string): ParsedCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('!')) return null;

  const withoutBang = trimmed.slice(1);
  const spaceIdx = withoutBang.indexOf(' ');
  const name = spaceIdx === -1 ? withoutBang : withoutBang.slice(0, spaceIdx);
  const args = spaceIdx === -1 ? '' : withoutBang.slice(spaceIdx + 1).trim();

  return { name: KNOWN_COMMANDS.has(name) ? name : 'unknown', args };
}

export interface PendingEntry {
  payload: string;
  expiresAt: number;
}

export class ConfirmationStore {
  private ttlMs: number;
  private store: Map<string, PendingEntry>;

  constructor(ttlMs: number) {
    this.ttlMs = ttlMs;
    this.store = new Map();
  }

  private key(channelId: string, userId: string, action: string): string {
    return `${channelId}:${userId}:${action}`;
  }

  set(channelId: string, userId: string, action: string, payload: string): void {
    this.store.set(this.key(channelId, userId, action), {
      payload,
      expiresAt: Date.now() + this.ttlMs,
    });
  }

  get(channelId: string, userId: string, action: string): PendingEntry | null {
    const k = this.key(channelId, userId, action);
    const entry = this.store.get(k);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(k);
      return null;
    }
    this.store.delete(k);
    return entry;
  }
}
