import type { JournalEvent } from '../journal/types.js';
import { readEvents } from '../journal/reader.js';

export interface CostBreakdown {
  total_cost_usd: number;
  by_account: Record<string, number>;
  /** Per aisup_session_id cost (sum of that session's per-segment maxima). */
  by_session: Record<string, number>;
}

/**
 * Rolling cost windows. These are the Phase 2 implementation of the PRD's daily/weekly cost
 * visibility; itemized calendar summaries remain deferred. `today` is since 00:00 UTC of the
 * current day; `last_7d`/`last_30d` are rolling N-day windows ending now.
 */
export interface CostWindows {
  today: CostBreakdown;
  last_7d: CostBreakdown;
  last_30d: CostBreakdown;
}

export interface AggregateCostsOptions {
  journalPath: string;
  /** Reference time for window boundaries; defaults to now. */
  now?: Date;
  /** Restrict aggregation to a single account. */
  account?: string;
}

const DAY_MS = 86_400_000;

/** Strip floating-point noise from accumulated cost sums while preserving sub-cent precision. */
function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

function roundMap(m: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(m)) out[k] = round(v);
  return out;
}

/**
 * Segment-aware reduction. `cost.total_cost_usd` is cumulative within a Claude session segment but
 * resets across account switches / new transcripts, so a running sum over raw snapshots would
 * double-count within a segment and mishandle the reset. Instead: group snapshots by
 * (aisup_session_id, claude_session_id), take the MAX cost per segment, then sum the per-segment
 * maxima — per aisup session and attributed to each segment's account.
 */
export function reduceCostSnapshots(events: JournalEvent[], accountFilter?: string): CostBreakdown {
  const segments = new Map<string, { max: number; account: string; aisupSessionId: string }>();

  for (const e of events) {
    if (e.event_type !== 'cost.snapshot') continue;
    const cost = e.details?.total_cost_usd;
    if (typeof cost !== 'number') continue;
    const account = e.account ?? 'unknown';
    if (accountFilter && account !== accountFilter) continue;
    const aisupSessionId = e.aisup_session_id ?? 'unknown';
    // Segment key: a Claude session id delineates a segment; fall back to the aisup session id so
    // snapshots that predate claude_session_id hydration still collapse to one segment (max).
    const segmentKey = `${aisupSessionId}::${e.claude_session_id ?? aisupSessionId}`;
    const prev = segments.get(segmentKey);
    if (!prev || cost > prev.max) {
      segments.set(segmentKey, { max: cost, account, aisupSessionId });
    }
  }

  const byAccount: Record<string, number> = {};
  const bySession: Record<string, number> = {};
  let total = 0;
  for (const seg of segments.values()) {
    total += seg.max;
    byAccount[seg.account] = (byAccount[seg.account] ?? 0) + seg.max;
    bySession[seg.aisupSessionId] = (bySession[seg.aisupSessionId] ?? 0) + seg.max;
  }

  return { total_cost_usd: round(total), by_account: roundMap(byAccount), by_session: roundMap(bySession) };
}

export type CostDimension = 'account' | 'skill' | 'provider' | 'task';

/**
 * C8: break cost down along one dimension across BOTH cost streams — lead-session `cost.snapshot`
 * (Claude, per-segment max) and per-worker `worker.completed` (discrete `cost_usd`). The two streams
 * are distinct and labelled: worker cost carries provider/task_type; lead cost carries account/skill
 * and buckets under `(lead)` for the task dimension. Worker cost is omitted from account/skill (not
 * attributable to a lead account/skill).
 */
export function breakdownCosts(events: JournalEvent[], dimension: CostDimension): Record<string, number> {
  const out: Record<string, number> = {};
  const add = (key: string, amt: number): void => { out[key] = round((out[key] ?? 0) + amt); };

  // Lead-session cost: per-segment max (same segmentation rule as reduceCostSnapshots).
  const segments = new Map<string, { max: number; account: string; skill: string; provider: string }>();
  for (const e of events) {
    if (e.event_type !== 'cost.snapshot') continue;
    const cost = e.details?.total_cost_usd;
    if (typeof cost !== 'number') continue;
    const aisupSessionId = e.aisup_session_id ?? 'unknown';
    const segmentKey = `${aisupSessionId}::${e.claude_session_id ?? aisupSessionId}`;
    const prev = segments.get(segmentKey);
    if (!prev || cost > prev.max) {
      segments.set(segmentKey, {
        max: cost,
        account: e.account ?? 'unknown',
        skill: (e.details?.active_skill as string | undefined) ?? '(none)',
        provider: (e.details?.provider as string | undefined) ?? 'claude',
      });
    }
  }
  for (const seg of segments.values()) {
    if (dimension === 'account') add(seg.account, seg.max);
    else if (dimension === 'skill') add(seg.skill, seg.max);
    else if (dimension === 'provider') add(seg.provider, seg.max);
    else add('(lead)', seg.max); // task dimension: lead cost has no task type
  }

  // Worker cost: each completion is a discrete cost, summed (never max).
  for (const e of events) {
    if (e.event_type !== 'worker.completed') continue;
    const cost = e.details?.cost_usd;
    if (typeof cost !== 'number') continue;
    if (dimension === 'provider') add((e.details?.provider as string | undefined) ?? 'unknown', cost);
    else if (dimension === 'task') add((e.details?.task_type as string | undefined) ?? '(untyped)', cost);
    // account/skill: worker cost is not attributable to a lead account/skill → omitted by design.
  }

  return out;
}

/** Aggregate journaled `cost.snapshot` events into rolling today / last_7d / last_30d windows. */
export async function aggregateCosts(opts: AggregateCostsOptions): Promise<CostWindows> {
  const events = await readEvents(opts.journalPath, { type: 'cost.snapshot' });
  const now = opts.now ?? new Date();

  const startOfTodayMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const since = (ms: number): string => new Date(ms).toISOString();
  const inWindow = (fromIso: string): JournalEvent[] => events.filter((e) => e.ts >= fromIso);

  return {
    today: reduceCostSnapshots(inWindow(since(startOfTodayMs)), opts.account),
    last_7d: reduceCostSnapshots(inWindow(since(now.getTime() - 7 * DAY_MS)), opts.account),
    last_30d: reduceCostSnapshots(inWindow(since(now.getTime() - 30 * DAY_MS)), opts.account),
  };
}
