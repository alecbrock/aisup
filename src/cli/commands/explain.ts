/**
 * `aisup explain <event_type>` — turn a journal event type into a human description so the
 * operator does not need to reverse-engineer `aisup log` output. Specific entries win; otherwise
 * a category description is derived from the event's prefix (see journal/types.ts EventType).
 */

/** High-value, operator-facing descriptions for the events they most often ask about. */
const SPECIFIC: Record<string, string> = {
  'session.start': 'A supervised Claude session started under the daemon.',
  'session.stop': 'A supervised session was stopped (by the operator or lifecycle).',
  'session.idle_detected': 'The session was detected idle (no output past the idle threshold).',
  'session.exhausted': 'No eligible failover account remained — the session is parked EXHAUSTED until an account recovers.',
  'account.switch': 'A failover moved the session from one account to another; details carry the reason and per-candidate rationale.',
  'cost.snapshot': 'A point-in-time cost reading for the active session/account (drives cost aggregation).',
  'permission.detected': 'Claude asked for permission to run a tool; the request was routed for approval.',
  'permission.granted': 'A permission request was approved (by Slack button or CLI).',
  'permission.denied': 'A permission request was denied.',
  'permission.keystroke_unconfirmed': 'An approval keystroke was skipped because the dialog was no longer active on re-scan.',
  'gate.run_completed': 'A validation-gate run finished; details list per-gate pass/fail.',
  'rate_limit.threshold_crossed': 'An account crossed a soft/hard usage threshold, arming failover.',
  'failover.no_target_available': 'Failover found no eligible target account (terminal unless a soft-threshold retry).',
  'worker.all_candidates_exhausted': 'Every worker provider/account candidate failed over; the worker ended FAILED.',
  'worker.candidate_failed': 'One worker candidate failed in a failover-worthy way (429/auth/timeout/unspawnable).',
  'worker.merged': 'A worker\'s approved patch was merged into the workspace.',
  'daemon.started': 'The aisup daemon process started and began supervising.',
  'daemon.rehydrated': 'The daemon restored session/worker/permission state after a restart.',
};

/** Prefix → category description, used when there is no specific entry. */
const CATEGORIES: Record<string, string> = {
  session: 'Supervised-session lifecycle event.',
  account: 'Account failover/selection event.',
  runner: 'Runner (tmux/pane) lifecycle event.',
  failure: 'A detected failure condition (auth/network/other).',
  recovery: 'A recovery attempt or its outcome.',
  cost: 'Cost/usage accounting event.',
  permission: 'Permission-request lifecycle event.',
  gate: 'Validation-gate event.',
  circuit_breaker: 'Circuit-breaker state change guarding a flapping account.',
  rate_limit: 'Rate-limit threshold event.',
  failover: 'Failover decision/outcome event.',
  migration: 'Transcript-migration event during a failover.',
  skill: 'Skill/slash-command detection event.',
  continuation: 'Continuation-injection event (resuming a skill/plan after a switch).',
  daemon: 'Daemon process lifecycle event.',
  telemetry: 'Statusline-telemetry health event.',
  slack: 'Slack integration event.',
  tmux: 'tmux interaction event.',
  output_log: 'Session output-log maintenance event.',
  worker: 'Multi-LLM worker lifecycle event.',
};

/** Return a human description for an event type, or a clear not-recognized message. */
export function describeEvent(eventType: string): string {
  const specific = SPECIFIC[eventType];
  if (specific) return specific;
  const prefix = eventType.split('.')[0];
  const category = CATEGORIES[prefix];
  if (category) return `${category} (event: ${eventType})`;
  return `"${eventType}" is not a recognized event type. Run \`aisup log\` to see event types in use.`;
}

/** `aisup explain <event_type>` entry point. */
export function runExplain(eventType: string): void {
  console.log(`${eventType}: ${describeEvent(eventType)}`);
}
