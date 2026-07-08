import type { JournalEvent } from '../journal/types.js';
import { reduceCostSnapshots } from '../cost/aggregator.js';

/** Slack modal text blocks cap around 3000 chars; above this we deliver content as a file upload (D4). */
export const MODAL_TEXT_LIMIT = 2900;

/** True when content is too large for a Block Kit modal and should be a file upload instead. */
export function isOversizedForModal(content: string): boolean {
  return content.length > MODAL_TEXT_LIMIT;
}

function formatDuration(ms: number): string {
  if (ms < 0 || !Number.isFinite(ms)) return 'unknown';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${sec}s`;
  return `${sec}s`;
}

const KEY_EVENTS = new Set<string>([
  'session.start', 'account.switch', 'session.exhausted',
  'recovery.success', 'gate.run_completed', 'worker.merged',
]);

/**
 * D4: compose a session-stop thread summary from that session's journal events — duration, account
 * switches, cost-for-session, and the trailing key lifecycle events. Reuses the C11 timeline data.
 */
export function buildStopSummary(events: JournalEvent[], sessionId: string): string {
  const sessionEvents = events
    .filter((e) => e.aisup_session_id === sessionId)
    .sort((a, b) => a.ts.localeCompare(b.ts));

  const start = sessionEvents.find((e) => e.event_type === 'session.start');
  const stop = [...sessionEvents].reverse().find((e) => e.event_type === 'session.stop');
  const switches = sessionEvents.filter(
    (e) => e.event_type === 'account.switch' && (e.details as { phase?: string } | undefined)?.phase === 'completed',
  ).length;
  const cost = reduceCostSnapshots(sessionEvents).by_session[sessionId] ?? 0;
  const duration = start && stop ? formatDuration(new Date(stop.ts).getTime() - new Date(start.ts).getTime()) : 'unknown';

  const key = sessionEvents.filter((e) => KEY_EVENTS.has(e.event_type)).slice(-8);
  const lines = [
    `:checkered_flag: Session \`${sessionId}\` ended.`,
    `• duration: ${duration}`,
    `• account switches: ${switches}`,
    `• cost: $${cost.toFixed(2)}`,
  ];
  if (key.length) {
    lines.push('• key events:');
    for (const e of key) {
      let ts = e.ts;
      try { ts = new Date(e.ts).toLocaleTimeString(); } catch { /* keep raw */ }
      lines.push(`   ${ts} ${e.event_type}${e.account ? ` [${e.account}]` : ''}`);
    }
  }
  return lines.join('\n');
}
