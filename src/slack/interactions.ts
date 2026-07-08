import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** Kind of interactive card, used to route an `app.action` to the right resolver. */
export type CardKind = 'permission' | 'worker' | 'activity';

/** A posted interactive card, keyed by an opaque `request_id` carried in every button value. */
export interface CardEntry {
  request_id: string;
  channel: string;
  message_ts: string;
  kind: CardKind;
  session_id?: string;
  /** Card-kind-specific data (tool/detail, diff, command) for rebuilding the Expand modal. */
  payload?: Record<string, unknown>;
  created_at?: string;
}

/**
 * In-memory + persisted registry of interactive cards. Persisted to `~/.aisup/slack-cards.json`
 * (0600) so a tap can be resolved after a daemon restart (A3) or hours later (A2). Mirrors the
 * 0600 + dir-0700 write pattern of `SlackService.saveChannelMap`.
 */
export class InteractionRegistry {
  private entries = new Map<string, CardEntry>();

  constructor(private path: string) {
    this.load();
  }

  /** Upsert a card and persist. */
  set(entry: CardEntry): void {
    this.entries.set(entry.request_id, { created_at: new Date().toISOString(), ...entry });
    this.save();
  }

  /** Look up a card by its opaque request_id. */
  get(requestId: string): CardEntry | null {
    return this.entries.get(requestId) ?? null;
  }

  /** Remove a card (e.g. once its request is resolved) and persist. */
  delete(requestId: string): void {
    if (this.entries.delete(requestId)) this.save();
  }

  /** All currently-tracked cards (used by restart reconciliation). */
  all(): CardEntry[] {
    return [...this.entries.values()];
  }

  private load(): void {
    if (!existsSync(this.path)) return;
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as CardEntry[];
      if (Array.isArray(raw)) {
        for (const e of raw) if (e?.request_id) this.entries.set(e.request_id, e);
      }
    } catch {
      // Corrupt store → start empty rather than crash; the next write heals it.
    }
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    writeFileSync(this.path, JSON.stringify(this.all(), null, 2), { mode: 0o600 });
  }
}

/** Parsed first action from a Slack `block_actions` payload. */
export interface ParsedBlockAction {
  action_id: string;
  request_id: string;
  user_id: string;
}

/** Extract the first button's action_id + value (request_id) + the actor from a block_actions body. */
export function parseBlockAction(payload: unknown): ParsedBlockAction | null {
  const body = payload as {
    actions?: Array<{ action_id?: string; value?: string }>;
    user?: { id?: string };
  };
  const action = body?.actions?.[0];
  if (!action?.action_id || action.value == null) return null;
  return { action_id: action.action_id, request_id: action.value, user_id: body.user?.id ?? 'unknown' };
}

/** Result of resolving a block_actions payload against the registry. */
export type InteractionRoute =
  | { matched: true; entry: CardEntry; action_id: string; user_id: string }
  | { matched: false; request_id: string | null; action_id: string | null };

/**
 * Resolve a block_actions payload to its registry entry BY request_id (never by channel/session —
 * concurrent cards in one channel would otherwise collide). Returns `{matched:false}` when the id
 * is unknown (e.g. a card whose request was already resolved or dropped).
 */
export function routeInteraction(payload: unknown, registry: InteractionRegistry): InteractionRoute {
  const parsed = parseBlockAction(payload);
  if (!parsed) return { matched: false, request_id: null, action_id: null };
  const entry = registry.get(parsed.request_id);
  if (!entry) return { matched: false, request_id: parsed.request_id, action_id: parsed.action_id };
  return { matched: true, entry, action_id: parsed.action_id, user_id: parsed.user_id };
}
