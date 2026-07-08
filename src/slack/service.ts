import { writeFileSync, readFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { App } from '@slack/bolt';
import {
  sendInterrupt,
  sendText,
  sendEnter,
  captureOutput,
} from '../session/tmux.js';
import { parseCommand, ConfirmationStore } from './commands.js';
import { isAllowedUser, isBotMessage, redactSecrets } from './relay.js';
import { buildChannelName, slugifyProjectName, isChannelNameTaken } from './channels.js';
import { InteractionRegistry, routeInteraction, type CardEntry } from './interactions.js';
import { permissionCard, permissionResolvedBlocks, activityRow, expandModal, workerCard, workerResolvedBlocks, PERM_ACTIONS, ACTIVITY_EXPAND_ACTION, WORKER_ACTIONS } from './blocks.js';
import { isMeaningful, renderActivityRow, renderActivityDetail, type Verbosity, type ActivityInput } from './activity.js';
import { accountsBlocks, costBlocks, providersBlocks, healthBlocks, type HealthView } from './observability.js';
import { randomUUID } from 'node:crypto';
import type { AccountView } from '../accounts/view.js';
import type { CostWindows } from '../cost/aggregator.js';
import type { ProviderUsageReport } from '../providers/report.js';
import type { KnownBlock } from '@slack/types';
import type { ThresholdAlert } from '../daemon/threshold-alert.js';
import type { SlackConfig, PermissionsConfig, NotificationsConfig } from '../config/schema.js';
import type { JournalWriter } from '../journal/types.js';
import { readEvents } from '../journal/reader.js';
import { buildStopSummary, isOversizedForModal } from './summary.js';
import type { SessionState } from '../session/types.js';
import type { SelectionRationale } from '../failover/types.js';

/** One-line failover rationale summary for a Slack message (empty when absent). */
function formatRationale(rationale?: SelectionRationale): string {
  if (!rationale || rationale.candidates.length === 0) return '';
  const lines = rationale.candidates.map((c) => {
    const score = typeof c.score === 'number' ? `${c.score.toFixed(0)}%` : 'no data';
    const status = c.name === rationale.chosen ? 'chosen' : (c.excluded_reason ?? 'eligible');
    return `• ${c.name}: ${score} (${status})`;
  });
  return `\nCandidates:\n${lines.join('\n')}`;
}
import type { PermissionRequest } from '../permissions/types.js';
import type { GateRunResult } from '../gates/types.js';
import type { WorkerState } from '../workers/types.js';

export interface SlackServiceOpts {
  config: SlackConfig;
  sessionManager: {
    getActiveSession(): SessionState | null;
    stopSession(tmuxName: string, sessionId: string, opts: { force?: boolean }): Promise<void>;
  };
  tmuxSocket: string;
  journal: JournalWriter;
  /** Path to the journal file — read by the D4 session-stop summary (`onSessionStop`) to compose
   *  duration/switches/cost/key-events. Distinct from `journal` (the writer). */
  journalPath?: string;
  channelMapPath: string;
  /** Where the interactive-card registry persists (defaults next to the channel map). */
  cardStorePath?: string;
  permissionsConfig?: PermissionsConfig;
  /** Notification defaults (activity-feed verbosity default; overridable per channel via `!notify`). */
  notificationsConfig?: NotificationsConfig;
  /** Resolve a Slack-routed permission via !permit / Approve button; resolves true only when the
   *  keystroke was sent. `requestId` (from the card) routes to the exact pending request; omitted
   *  for legacy `!permit`, which resolves FIFO. */
  onPermissionGrant?: (sessionId: string, requestId?: string) => boolean | Promise<boolean>;
  /** Resolve a Slack-routed permission via !deny / Deny button; resolves true only when the keystroke was sent. */
  onPermissionDeny?: (sessionId: string, requestId?: string) => boolean | Promise<boolean>;
  /** Run the configured validation gates (Slack !gate). */
  onGateRun?: () => Promise<GateRunResult>;
  /** Latest gate run for Slack !gate status. */
  getLatestGateRun?: () => GateRunResult | null;
  /** Approve a worker patch via `!worker approve <id>` — resolves ok only on a real transition. */
  onWorkerApprove?: (id: string) => Promise<{ ok: boolean; reason?: string }>;
  /** Re-dispatch a failed worker via `!worker retry <id>` — resolves with the new worker id (C6). */
  onWorkerRetry?: (id: string) => Promise<{ ok: boolean; reason?: string; id?: string }>;
  /** Deny a worker patch via `!worker deny <id>` — resolves ok only on a real transition. */
  onWorkerDeny?: (id: string) => Promise<{ ok: boolean; reason?: string }>;
  /** Current worker states for `!worker status`. */
  getWorkerStatus?: () => WorkerState[];
  /** Sanitized worker diff for the Slack worker card + `!worker diff` (reuses the orchestrator's
   *  sanitize/persist boundary — never an unsanitized worktree diff). */
  getWorkerDiff?: (id: string) => { title: string; patch: string } | null;
  /** Read-only observability readers (A6) — reuse the same aggregations as the HTTP API / CLI so
   *  `!accounts`/`!cost`/`!worker providers`/`!health` report identical numbers. */
  getAccountsView?: () => Promise<AccountView[]> | AccountView[];
  /** C7: apply a runtime account override via `!account pin|exclude|enable|disable|clear <name>`. */
  onAccountOverride?: (action: 'pin' | 'exclude' | 'enable' | 'disable' | 'clear', name?: string) => Promise<{ ok: boolean; error?: string }>;
  /** C9: pause/resume the active session via `!pause` / `!resume`. */
  onSessionPause?: () => Promise<{ ok: boolean; reason?: string }>;
  onSessionResume?: () => Promise<{ ok: boolean; reason?: string }>;
  getCostView?: () => Promise<CostWindows> | CostWindows;
  getWorkerProvidersView?: () => ProviderUsageReport | null;
  getHealthView?: () => Promise<HealthView> | HealthView;
}

/** Upper bound on channel-name suffix retries before giving up on creation. */
const MAX_CHANNEL_SUFFIX = 100;

/** True when a Slack Web API error represents a rate-limit response. */
function isRateLimited(err: unknown): boolean {
  const e = err as { code?: string; data?: { error?: string }; status?: number } | null;
  return (
    e?.code === 'slack_webapi_rate_limited_error' ||
    e?.data?.error === 'ratelimited' ||
    e?.status === 429
  );
}

/** Extract the retry-after seconds from a Slack rate-limit error, or null. */
function rateLimitRetryAfter(err: unknown): number | null {
  const e = err as { retryAfter?: number; data?: { retry_after?: number } } | null;
  return e?.retryAfter ?? e?.data?.retry_after ?? null;
}

export class SlackService {
  private opts: SlackServiceOpts;
  private app: App | null = null;
  private channelMap = new Map<string, string>(); // sessionId → channelId
  private relayEnabled = new Map<string, boolean>(); // channelId → relay on/off
  private relayHandle: ReturnType<typeof setInterval> | null = null;
  private outputCursors = new Map<string, { path: string; offset: number; generation: number }>();
  private lastPostTime = new Map<string, number>();
  private confirmations = new ConfirmationStore(60_000);
  private redactionPatterns: RegExp[];
  private interactions: InteractionRegistry;
  private activityThreads = new Map<string, string>(); // channelId → "Activity" thread root ts
  private verbosityByChannel = new Map<string, Verbosity>(); // channelId → feed verbosity (A5)
  private verbosityStorePath: string;

  constructor(opts: SlackServiceOpts) {
    this.opts = opts;
    this.redactionPatterns = opts.config.redaction_patterns.flatMap((p) => {
      try { return [new RegExp(p, 'gi')]; } catch { return []; }
    });
    const cardStorePath = opts.cardStorePath ?? join(dirname(opts.channelMapPath), 'slack-cards.json');
    this.interactions = new InteractionRegistry(cardStorePath);
    this.verbosityStorePath = join(dirname(opts.channelMapPath), 'notify-verbosity.json');
    this.loadVerbosity();
  }

  async start(): Promise<void> {
    const { config, channelMapPath } = this.opts;
    const botToken = process.env[config.bot_token_env] ?? '';
    const appToken = process.env[config.app_token_env] ?? '';

    this.channelMap = this.loadChannelMap(channelMapPath);

    this.app = new App({ token: botToken, appToken, socketMode: true });
    this.app.message(async (args) => {
      await this.handleMessage(
        args.message as unknown as Record<string, unknown>,
        args.say as unknown as (text: string) => Promise<void>
      );
    });
    // Interactive surface (Phase A): Block Kit buttons/modals. Each handler acks fast (<3s) then
    // routes by action_id against the request_id registry — never by channel/session alone.
    this.app.action(/^(perm|worker|activity)_/, async (args) => {
      await this.handleAction(
        args.body as unknown as Record<string, unknown>,
        args.ack as unknown as () => Promise<void>
      );
    });
    this.app.view(/.*/, async (args) => {
      await (args.ack as unknown as () => Promise<void>)();
    });

    await this.app.start();
    await this.probeInteractivity();
    if (config.relay_output_enabled) {
      this.startRelay();
    }
  }

  async stop(): Promise<void> {
    this.stopRelay();
    if (this.app) {
      await this.app.stop();
      this.app = null;
    }
  }

  async onSessionStart(session: SessionState): Promise<void> {
    if (!this.app) return;
    const { config } = this.opts;
    const projectSlug = slugifyProjectName(session.cwd);
    const baseName = buildChannelName(projectSlug, session.aisup_session_id);

    let channelId: string | undefined;
    let nameSuffix = 0;

    while (!channelId) {
      const name = nameSuffix === 0 ? baseName : `${baseName}-${nameSuffix}`;
      try {
        const result = await this.app.client.conversations.create({
          name,
          is_private: true,
        } as Parameters<typeof this.app.client.conversations.create>[0]);
        channelId = (result as { channel?: { id?: string } }).channel?.id;
      } catch (err) {
        if (isChannelNameTaken(err)) {
          await this.opts.journal.append({
            ts: new Date().toISOString(),
            event_type: 'slack.channel_name_collision',
            aisup_session_id: session.aisup_session_id,
            details: { attempted_name: name, next_suffix: nameSuffix + 1 },
          });
          nameSuffix++;
          if (nameSuffix > MAX_CHANNEL_SUFFIX) {
            await this.opts.journal.append({
              ts: new Date().toISOString(),
              event_type: 'slack.connection_error',
              aisup_session_id: session.aisup_session_id,
              details: { error: 'channel name suffix limit exceeded', op: 'conversations.create' },
            });
            return;
          }
        } else {
          await this.opts.journal.append({
            ts: new Date().toISOString(),
            event_type: 'slack.connection_error',
            aisup_session_id: session.aisup_session_id,
            details: { error: String(err), op: 'conversations.create' },
          });
          return;
        }
      }
    }

    // Invite all allowed users
    for (const userId of config.allowed_user_ids) {
      try {
        await this.app.client.conversations.invite({
          channel: channelId,
          users: userId,
        });
      } catch (err) {
        // already_in_channel / cant_invite_self are expected and benign; surface anything else so a
        // misconfigured workspace (bad scopes, archived channel) is observable, not silent (AF-327).
        const code = (err as { data?: { error?: string } }).data?.error ?? (err instanceof Error ? err.message : String(err));
        if (code !== 'already_in_channel' && code !== 'cant_invite_self') {
          await this.opts.journal.append({
            ts: new Date().toISOString(),
            event_type: 'slack.invite_failed',
            aisup_session_id: session.aisup_session_id,
            details: { channel: channelId, user: userId, error: code },
          });
        }
      }
    }

    this.channelMap.set(session.aisup_session_id, channelId);
    this.saveChannelMap();

    await this.opts.journal.append({
      ts: new Date().toISOString(),
      event_type: 'slack.channel_created',
      aisup_session_id: session.aisup_session_id,
      details: { channel_id: channelId },
    });

    // PRD Flow 1 step 5: post session info so the channel opens with context, not just joins.
    try {
      await this.app.client.chat.postMessage({
        channel: channelId,
        text: [
          ':rocket: *Supervised session started*',
          `• Session: \`${session.aisup_session_id}\``,
          `• Account: \`${session.account}\``,
          `• Directory: \`${session.cwd}\``,
        ].join('\n'),
      });
    } catch { /* best effort */ }
  }

  async onSessionStop(sessionId: string): Promise<void> {
    if (!this.app) return;
    const channelId = this.channelMap.get(sessionId);
    if (!channelId) return;

    // D4: compose a stop-thread summary (duration, switches, cost, key events) from the journal.
    let text = `Session \`${sessionId}\` has ended.`;
    try {
      if (this.opts.journalPath) {
        const events = await readEvents(this.opts.journalPath, { session: sessionId, limit: 1000 });
        text = buildStopSummary(events, sessionId);
      }
    } catch { /* fall back to the plain notice */ }

    try {
      await this.app.client.chat.postMessage({ channel: channelId, text });
    } catch { /* best effort */ }
  }

  /** D4: deliver oversized content (a diff/command too big for a modal) as a Slack file upload. */
  private async uploadLargeContent(channelId: string, title: string, content: string): Promise<void> {
    if (!this.app) return;
    const filename = `${title.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 40) || 'output'}.diff`;
    try {
      await this.app.client.files.uploadV2({ channel_id: channelId, filename, title, content });
    } catch { /* best effort — requires the files:write scope (doctor flags if missing) */ }
  }

  /** Notify the session channel that the session is EXHAUSTED (no failover target available).
   *  The optional rationale (C2) explains WHY no candidate was eligible. */
  async onSessionExhausted(sessionId: string, reason: string, rationale?: SelectionRationale): Promise<void> {
    if (!this.app) return;
    const channelId = this.channelMap.get(sessionId);
    if (!channelId) return;

    const why = formatRationale(rationale);
    try {
      await this.app.client.chat.postMessage({
        channel: channelId,
        text: `:warning: Session \`${sessionId}\` is EXHAUSTED — no eligible failover account is available (reason: ${reason}).${why}`,
      });
    } catch { /* best effort */ }
  }

  /**
   * Notify the active session's channel that a worker crossed LLM providers (claude↔codex). Best-effort.
   * Account-to-account failover within Claude is routine and NOT notified here — the daemon only calls
   * this for cross-provider failovers.
   */
  async notifyWorkerFailover(opts: { sessionId: string | null; taskId: string; from: string; to: string }): Promise<void> {
    if (!this.app) return;
    const channelId = opts.sessionId ? this.channelMap.get(opts.sessionId) : undefined;
    if (!channelId) return;
    try {
      await this.app.client.chat.postMessage({
        channel: channelId,
        text: `:arrows_counterclockwise: Worker \`${opts.taskId}\` failed over across providers: *${opts.from}* → *${opts.to}*.`,
      });
    } catch { /* best effort */ }
  }

  /** Post an interactive permission card (Approve/Deny buttons) to the session's channel; falls back
   *  to a `!permit`/`!deny` text prompt only for an id-less legacy request. */
  async notifyPermissionRequest(sessionId: string, request: PermissionRequest): Promise<void> {
    if (!this.app) return;
    const channelId = this.channelMap.get(sessionId);
    if (!channelId) return;
    const requestId = request.request_id;
    // A2: post an interactive Block Kit card (Approve / Approve-for-session? / Deny) keyed by the
    // request_id and register it so a tap — even hours later or after a restart — resolves the exact
    // request. The legacy text prompt remains only for an id-less request (defensive; the hook always
    // sets request_id now). The card is posted to the channel root so it is never missed.
    if (requestId) {
      try {
        const blocks = permissionCard({
          requestId,
          tool: request.tool,
          summary: this.redactAndTruncate(request.detail, 300),
          preview: this.redactAndTruncate(request.detail, 600),
          includeApproveForSession: !!this.opts.permissionsConfig?.approval_session_key,
        });
        const res = await this.app.client.chat.postMessage({
          channel: channelId,
          text: `Claude is requesting permission to use ${request.tool}`,
          blocks,
        });
        const ts = (res as { ts?: string }).ts;
        if (ts) {
          this.registerCard({
            request_id: requestId,
            channel: channelId,
            message_ts: ts,
            kind: 'permission',
            session_id: sessionId,
            payload: { tool: request.tool, detail: request.detail },
          });
        }
      } catch { /* best effort */ }
      return;
    }
    try {
      await this.app.client.chat.postMessage({
        channel: channelId,
        text: `:lock: Claude is requesting permission: \`${request.tool}: ${this.redactAndTruncate(request.detail, 200)}\`\nReply \`!permit\` to allow or \`!deny\` to deny.`,
      });
    } catch { /* best effort */ }
  }

  /** Register an interactive card so its buttons can be resolved later (A2/A3/A4/A7). */
  registerCard(entry: CardEntry): void {
    this.interactions.set(entry);
  }

  /**
   * Restart reconciliation (A3): for each persisted permission card, re-bind it when its session is
   * still live (the persisted queue + card make a tap resolve the original request with no operator
   * re-send), or annotate it stale and drop it when the session is gone — never a silent drop.
   */
  async reconcilePendingPermissions(isSessionLive: (sessionId: string) => boolean): Promise<{ rebound: number; stale: number }> {
    let rebound = 0;
    let stale = 0;
    for (const entry of this.interactions.all()) {
      if (entry.kind !== 'permission') continue;
      const live = entry.session_id ? isSessionLive(entry.session_id) : false;
      if (live) {
        rebound++;
        await this.opts.journal.append({
          ts: new Date().toISOString(),
          event_type: 'permission.card_rebound',
          aisup_session_id: entry.session_id,
          details: { request_id: entry.request_id },
        });
        continue;
      }
      stale++;
      const tool = String(entry.payload?.tool ?? 'tool');
      const summary = String(entry.payload?.detail ?? '');
      const outcome = ':ghost: Session ended — this request is no longer actionable';
      if (this.app) {
        try {
          await this.app.client.chat.update({
            channel: entry.channel,
            ts: entry.message_ts,
            text: outcome,
            blocks: permissionResolvedBlocks({ tool, summary, outcome }),
          } as Parameters<typeof this.app.client.chat.update>[0]);
        } catch { /* best effort */ }
      }
      this.interactions.delete(entry.request_id);
      await this.opts.journal.append({
        ts: new Date().toISOString(),
        event_type: 'permission.card_stale',
        aisup_session_id: entry.session_id,
        details: { request_id: entry.request_id },
      });
    }
    return { rebound, stale };
  }

  /** Look up a registered card by request_id. */
  getCard(requestId: string): CardEntry | null {
    return this.interactions.get(requestId);
  }

  /** C13: hot-apply the default activity-feed verbosity (per-channel `!notify` overrides still win). */
  setDefaultVerbosity(verbosity: Verbosity): void {
    if (this.opts.notificationsConfig) this.opts.notificationsConfig.verbosity = verbosity;
  }

  /** C13: hot-apply the Slack command allow-list without a restart. */
  setAllowedUsers(userIds: string[]): void {
    this.opts.config.allowed_user_ids = userIds;
  }

  /** Current activity-feed verbosity for a channel: per-channel `!notify` override, else config default. */
  private activityVerbosity(channelId: string): Verbosity {
    return this.verbosityByChannel.get(channelId) ?? this.opts.notificationsConfig?.verbosity ?? 'normal';
  }

  private loadVerbosity(): void {
    if (!existsSync(this.verbosityStorePath)) return;
    try {
      const raw = JSON.parse(readFileSync(this.verbosityStorePath, 'utf8')) as Record<string, Verbosity>;
      for (const [ch, v] of Object.entries(raw)) {
        if (v === 'silent' || v === 'normal' || v === 'verbose') this.verbosityByChannel.set(ch, v);
      }
    } catch { /* corrupt → ignore */ }
  }

  private saveVerbosity(): void {
    try {
      mkdirSync(dirname(this.verbosityStorePath), { recursive: true, mode: 0o700 });
      writeFileSync(this.verbosityStorePath, JSON.stringify(Object.fromEntries(this.verbosityByChannel), null, 2), { mode: 0o600 });
    } catch { /* best effort */ }
  }

  private redact(text: string): string {
    return redactSecrets(text, this.redactionPatterns);
  }

  /** Post a rich Block Kit message to a channel with a plain-text notification fallback. */
  private async postBlocks(channelId: string, fallback: string, blocks: KnownBlock[]): Promise<void> {
    if (!this.app) return;
    try {
      await this.app.client.chat.postMessage({ channel: channelId, text: fallback, blocks } as Parameters<typeof this.app.client.chat.postMessage>[0]);
    } catch { /* best effort */ }
  }

  /**
   * Post an interactive worker card when a worker reaches `awaiting_approval` (A7): task title +
   * sanitized patch summary + Expand-diff modal + Approve / Deny buttons. Approve/Deny route through
   * the existing integrity-anchored merge handlers; the buttons are UI only. Best-effort.
   */
  async notifyWorkerAwaitingApproval(sessionId: string | null, workerId: string): Promise<void> {
    if (!this.app) return;
    const channelId = sessionId ? this.channelMap.get(sessionId) : undefined;
    if (!channelId) return;
    const diff = this.opts.getWorkerDiff?.(workerId);
    const title = diff?.title ?? `Worker ${workerId}`;
    const patch = diff?.patch ?? '';
    const summary = `${patch.split('\n').filter((l) => /^[+-]/.test(l) && !/^[+-]{3}/.test(l)).length} changed lines`;
    const requestId = randomUUID();
    try {
      const res = await this.app.client.chat.postMessage({
        channel: channelId,
        text: `Worker ${workerId} is ready for review`,
        blocks: workerCard({ requestId, title, summary, preview: patch ? patch.slice(0, 600) : undefined }),
      } as Parameters<typeof this.app.client.chat.postMessage>[0]);
      const ts = (res as { ts?: string }).ts;
      if (ts) {
        this.registerCard({
          request_id: requestId,
          channel: channelId,
          message_ts: ts,
          kind: 'worker',
          session_id: sessionId ?? undefined,
          payload: { workerId, title, content: patch },
        });
      }
    } catch { /* best effort */ }
  }

  /**
   * Push a proactive threshold/budget alert (A8). ALWAYS posts — unlike the activity feed, alerts are
   * never suppressed by `!notify silent`. De-duping (one per band crossing) happens upstream in the
   * `ThresholdAlerter`; this just delivers.
   */
  async notifyThreshold(sessionId: string | null, alert: ThresholdAlert): Promise<void> {
    if (!this.app) return;
    const channelId = sessionId ? this.channelMap.get(sessionId) : undefined;
    if (!channelId) return;
    const icon = alert.band === 'hard' ? ':red_circle:' : alert.band === 'soft' ? ':warning:' : ':large_yellow_circle:';
    const pct = (v: number | null): string => (typeof v === 'number' ? `${Math.round(v)}%` : '—');
    const eta = alert.reset_eta ? ` · resets ${alert.reset_eta}` : '';
    try {
      await this.app.client.chat.postMessage({
        channel: channelId,
        text: `${icon} *${alert.band.toUpperCase()}* usage on \`${alert.account}\` — 5h ${pct(alert.five_hour_pct)} · 7d ${pct(alert.seven_day_pct)}${eta}`,
      });
    } catch { /* best effort */ }
  }

  /** Resolve an Approve / Deny tap on a worker card via the existing merge handlers; update in place. */
  private async resolveWorkerAction(entry: CardEntry, actionId: string, userId: string): Promise<void> {
    const approve = actionId === WORKER_ACTIONS.approve;
    const workerId = String(entry.payload?.workerId ?? '');
    const title = String(entry.payload?.title ?? `Worker ${workerId}`);
    const handler = approve ? this.opts.onWorkerApprove : this.opts.onWorkerDeny;
    if (!handler) return;
    const result = await handler(workerId);
    const outcome = result.ok
      ? (approve ? `:white_check_mark: Approved & merged by <@${userId}>` : `:no_entry: Denied by <@${userId}>`)
      : `:warning: ${result.reason ?? 'action failed'} (<@${userId}>)`;
    if (this.app) {
      try {
        await this.app.client.chat.update({
          channel: entry.channel,
          ts: entry.message_ts,
          text: outcome,
          blocks: workerResolvedBlocks({ title, outcome }),
        } as Parameters<typeof this.app.client.chat.update>[0]);
      } catch { /* best effort */ }
    }
    if (result.ok) this.interactions.delete(entry.request_id);
    await this.opts.journal.append({
      ts: new Date().toISOString(),
      event_type: 'slack.interaction',
      details: { action_id: actionId, request_id: entry.request_id, kind: 'worker', worker_id: workerId, user: userId, resolved: result.ok },
    });
  }

  /**
   * Post a tool-activity row to the session channel's "Activity" thread (A4). Classified against the
   * channel's verbosity (`silent` suppresses the feed; `normal` = meaningful tools; `verbose` = all),
   * ANSI-stripped and secret-redacted. Each row carries an Expand button whose modal shows the full
   * unified diff (Edit/Write) or exact command (Bash). Fire-and-forget; best-effort.
   */
  async postActivity(sessionId: string, input: ActivityInput): Promise<void> {
    if (!this.app) return;
    const channelId = this.channelMap.get(sessionId);
    if (!channelId) return;
    if (!isMeaningful(input.toolName, this.activityVerbosity(channelId))) return;

    const redact = (s: string): string => this.redact(s);
    const row = renderActivityRow(input, redact);
    const detail = renderActivityDetail(input, redact);
    const requestId = randomUUID();
    const threadTs = await this.ensureActivityThread(channelId);
    try {
      const res = await this.app.client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: `${row.icon} ${row.summary}`,
        blocks: activityRow({ requestId, icon: row.icon, summary: row.summary }),
      } as Parameters<typeof this.app.client.chat.postMessage>[0]);
      const ts = (res as { ts?: string }).ts;
      if (ts) {
        this.registerCard({
          request_id: requestId,
          channel: channelId,
          message_ts: ts,
          kind: 'activity',
          session_id: sessionId,
          payload: { title: detail.title, content: detail.content },
        });
      }
      await this.opts.journal.append({
        ts: new Date().toISOString(),
        event_type: 'activity.posted',
        aisup_session_id: sessionId,
        details: { tool: input.toolName },
      });
    } catch { /* best effort */ }
  }

  /** Ensure the channel has an "Activity" thread root and return its ts. */
  private async ensureActivityThread(channelId: string): Promise<string | undefined> {
    const existing = this.activityThreads.get(channelId);
    if (existing) return existing;
    if (!this.app) return undefined;
    try {
      const res = await this.app.client.chat.postMessage({
        channel: channelId,
        text: ':satellite: *Activity* — Claude\'s actions appear in this thread',
      });
      const ts = (res as { ts?: string }).ts;
      if (ts) this.activityThreads.set(channelId, ts);
      return ts;
    } catch {
      return undefined;
    }
  }

  /** Open an Expand modal (activity diff/command, or worker patch) using the action's trigger_id. */
  private async openExpandModal(payload: Record<string, unknown>, entry: CardEntry): Promise<void> {
    if (!this.app) return;
    const title = String(entry.payload?.title ?? 'Details');
    const content = String(entry.payload?.content ?? '');
    // D4: content too large for a modal is delivered as a file upload instead of a truncated modal.
    const channelId = (payload as { channel?: { id?: string } }).channel?.id;
    if (isOversizedForModal(content) && channelId) {
      await this.uploadLargeContent(channelId, title, content);
      return;
    }
    const triggerId = (payload as { trigger_id?: string }).trigger_id;
    if (!triggerId) return;
    try {
      await this.app.client.views.open({
        trigger_id: triggerId,
        view: expandModal({ title, content }),
      } as Parameters<typeof this.app.client.views.open>[0]);
    } catch { /* best effort */ }
  }

  /**
   * Handle a Block Kit `block_actions` payload. Acks immediately (<3s Slack budget), then routes by
   * action_id to the card's request_id. A2/A4/A7 attach concrete resolvers per action_id; A1 wires
   * the routing + observability so a tap is never silently dropped.
   */
  async handleAction(payload: Record<string, unknown>, ack: () => Promise<void>): Promise<void> {
    await ack();
    const route = routeInteraction(payload, this.interactions);
    if (!route.matched) {
      await this.opts.journal.append({
        ts: new Date().toISOString(),
        event_type: 'slack.interaction_unmatched',
        details: { action_id: route.action_id, request_id: route.request_id },
      });
      return;
    }
    const { entry, action_id, user_id } = route;
    if (action_id === PERM_ACTIONS.approve || action_id === PERM_ACTIONS.approveSession || action_id === PERM_ACTIONS.deny) {
      await this.resolvePermissionAction(entry, action_id, user_id);
      return;
    }
    if (action_id === ACTIVITY_EXPAND_ACTION || action_id === WORKER_ACTIONS.diff) {
      await this.openExpandModal(payload, entry);
      return;
    }
    if (action_id === WORKER_ACTIONS.approve || action_id === WORKER_ACTIONS.deny) {
      await this.resolveWorkerAction(entry, action_id, user_id);
      return;
    }
    // Any remaining action is journaled for observability.
    await this.opts.journal.append({
      ts: new Date().toISOString(),
      event_type: 'slack.interaction',
      aisup_session_id: entry.session_id,
      details: { action_id, request_id: entry.request_id, kind: entry.kind, user: user_id },
    });
  }

  /**
   * Resolve an Approve / Approve-for-session / Deny tap. Routes the card's request_id through the
   * unified keystroke resolver (which sends the keystroke ONLY after a `promptStillActive` re-scan),
   * then updates the card in place to show the outcome and who decided. A failed resolution (the
   * dialog closed) annotates the card and keeps it — never a silent drop.
   */
  private async resolvePermissionAction(entry: CardEntry, actionId: string, userId: string): Promise<void> {
    const approve = actionId !== PERM_ACTIONS.deny;
    const sessionId = entry.session_id ?? '';
    const fn = approve ? this.opts.onPermissionGrant : this.opts.onPermissionDeny;
    const ok = fn ? await fn(sessionId, entry.request_id) : false;
    const tool = String(entry.payload?.tool ?? 'tool');
    const summary = String(entry.payload?.detail ?? '');
    const outcome = ok
      ? (approve ? `:white_check_mark: Approved by <@${userId}>` : `:no_entry: Denied by <@${userId}>`)
      : `:warning: Could not resolve — prompt no longer active (<@${userId}>)`;
    if (this.app) {
      try {
        await this.app.client.chat.update({
          channel: entry.channel,
          ts: entry.message_ts,
          text: outcome,
          blocks: permissionResolvedBlocks({ tool, summary, outcome }),
        } as Parameters<typeof this.app.client.chat.update>[0]);
      } catch { /* best effort */ }
    }
    if (ok) this.interactions.delete(entry.request_id);
    await this.opts.journal.append({
      ts: new Date().toISOString(),
      event_type: 'slack.interaction',
      aisup_session_id: sessionId || undefined,
      details: { action_id: actionId, request_id: entry.request_id, kind: 'permission', user: userId, resolved: ok },
    });
  }

  /**
   * Startup pre-check for the Slack-app Interactivity toggle (required for Block Kit buttons in
   * Socket Mode). The toggle is not readable via API, so it is operator-asserted via
   * `slack.interactivity_enabled`: when false we journal `slack.interactivity_unverified` so button
   * routing never fails silently and `doctor` (C5) can surface it. The live scope/toggle check is
   * doctor's job.
   */
  async probeInteractivity(): Promise<void> {
    if (this.opts.config.interactivity_enabled) return;
    await this.opts.journal.append({
      ts: new Date().toISOString(),
      event_type: 'slack.interactivity_unverified',
      details: { reason: 'interactivity_enabled is false — Block Kit buttons require the Slack app Interactivity toggle ON' },
    });
  }

  private formatGateSummary(result: GateRunResult): string {
    const head = `Gates: ${result.passed ? ':white_check_mark: PASSED' : ':x: FAILED'}`;
    const failed = result.results.filter((r) => r.status !== 'passed').map((r) => `${r.name} (${r.status})`);
    return failed.length ? `${head}\nFailed: ${failed.join(', ')}` : head;
  }

  private formatWorkerSummary(workers: WorkerState[]): string {
    const line = (w: WorkerState): string => {
      let s = `\`${w.task.id}\` ${w.status} — ${w.task.title}`;
      // C3: surface which candidates were tried + why when a worker exhausted, so the operator
      // sees the failure story inline instead of grepping the journal.
      if (w.tried_candidates && w.tried_candidates.length > 0) {
        const tried = w.tried_candidates
          .map((c) => `${c.provider === 'claude' ? `claude:${c.account ?? '?'}` : c.provider}=${c.reason}`)
          .join(', ');
        s += `\n    tried: ${tried}`;
      }
      return s;
    };
    return ['*Workers:*', ...workers.map(line)].join('\n');
  }

  resetRelayCursor(sessionId: string, path: string): void {
    const existing = this.outputCursors.get(sessionId);
    this.outputCursors.set(sessionId, {
      path,
      offset: 0,
      generation: (existing?.generation ?? 0) + 1,
    });
  }

  getChannelId(sessionId: string): string | null {
    return this.channelMap.get(sessionId) ?? null;
  }

  private async handleMessage(
    message: Record<string, unknown>,
    say: (text: string) => Promise<void>
  ): Promise<void> {
    // Ignore bot messages (echo prevention)
    if (isBotMessage(message as Parameters<typeof isBotMessage>[0])) {
      await this.opts.journal.append({
        ts: new Date().toISOString(),
        event_type: 'slack.message_ignored',
        details: { reason: 'bot_or_system_message', subtype: String(message['subtype'] ?? ''), channel: String(message['channel'] ?? '') },
      });
      return;
    }

    const userId = message['user'] as string | undefined;
    const text = (message['text'] as string | undefined) ?? '';
    const channelId = (message['channel'] as string | undefined) ?? '';

    // Enforce allowed users
    if (!userId || !isAllowedUser(userId, this.opts.config.allowed_user_ids)) {
      await this.opts.journal.append({
        ts: new Date().toISOString(),
        event_type: 'slack.message_ignored',
        details: { reason: 'unauthorized_user', user: userId ?? 'unknown', channel: channelId },
      });
      return;
    }

    const cmd = parseCommand(text);
    if (!cmd) {
      const session = this.opts.sessionManager.getActiveSession();
      if (session && this.opts.config.relay_output_enabled && this.relayEnabled.get(channelId)) {
        sendText(this.opts.tmuxSocket, session.tmux_name, text);
        sendEnter(this.opts.tmuxSocket, session.tmux_name);
      } else {
        await this.opts.journal.append({
          ts: new Date().toISOString(),
          event_type: 'slack.message_ignored',
          details: { reason: 'relay_disabled', channel: channelId },
        });
      }
      return;
    }

    await this.dispatchCommand(cmd.name, cmd.args, userId, channelId, say);
  }

  private async dispatchCommand(
    name: string,
    args: string,
    userId: string,
    channelId: string,
    say: (text: string) => Promise<void>
  ): Promise<void> {
    const { sessionManager, tmuxSocket, config } = this.opts;
    const session = sessionManager.getActiveSession();

    switch (name) {
      case 'interrupt': {
        if (!session) { await say('No active session.'); return; }
        sendInterrupt(tmuxSocket, session.tmux_name);
        await say('Interrupted.');
        break;
      }

      case 'stop': {
        if (!session) { await say('No active session.'); return; }
        this.confirmations.set(channelId, userId, 'stop', session.aisup_session_id);
        await say('Session will be terminated. Reply `!confirm` within 60s to proceed.');
        break;
      }

      case 'confirm': {
        // Check for pending stop
        const pending = this.confirmations.get(channelId, userId, 'stop');
        if (pending) {
          const state = sessionManager.getActiveSession();
          if (state) {
            await sessionManager.stopSession(state.tmux_name, state.aisup_session_id, { force: false });
            await this.opts.journal.append({
              ts: new Date().toISOString(),
              event_type: 'session.stop',
              aisup_session_id: state.aisup_session_id,
              details: { reason: 'slack_requested', force: false, account: state.account, cwd: state.cwd },
            });
            await this.onSessionStop(state.aisup_session_id);
            await say('Session stopped.');
          }
          return;
        }
        // Check for pending cmd
        const pendingCmd = this.confirmations.get(channelId, userId, 'cmd');
        if (pendingCmd) {
          if (!session) { await say('No active session.'); return; }
          sendText(tmuxSocket, session.tmux_name, pendingCmd.payload);
          sendEnter(tmuxSocket, session.tmux_name);
          await say(`Sent: \`${this.redactAndTruncate(pendingCmd.payload, 300)}\``);
          return;
        }
        // Check for a pending worker approve/deny (applies a patch to the workspace).
        for (const wAction of ['approve', 'deny'] as const) {
          const pendingWorker = this.confirmations.get(channelId, userId, `worker_${wAction}`);
          if (!pendingWorker) continue;
          const handler = wAction === 'approve' ? this.opts.onWorkerApprove : this.opts.onWorkerDeny;
          if (!handler) { await say('Worker actions are not enabled.'); return; }
          const res = await handler(pendingWorker.payload);
          await say(res.ok
            ? `Worker ${pendingWorker.payload}: ${wAction} ok.`
            : `Worker ${pendingWorker.payload}: ${wAction} did not apply${res.reason ? ` (${res.reason})` : ''}.`);
          return;
        }
        await say('No pending confirmation.');
        break;
      }

      case 'status': {
        if (!session) { await say('No active session.'); return; }
        const output = captureOutput(tmuxSocket, session.tmux_name, 50);
        const redacted = redactSecrets(output, this.redactionPatterns);
        await say(`\`\`\`\n${redacted}\n\`\`\``);
        break;
      }

      case 'cmd': {
        if (!session) { await say('No active session.'); return; }
        if (config.cmd_require_confirmation) {
          this.confirmations.set(channelId, userId, 'cmd', args);
          await say(`Will send: \`${this.redactAndTruncate(args, 300)}\`. Reply \`!confirm\` within 60s.`);
          return;
        }
        sendText(tmuxSocket, session.tmux_name, args);
        sendEnter(tmuxSocket, session.tmux_name);
        await say(`Sent: \`${this.redactAndTruncate(args, 300)}\``);
        break;
      }

      case 'relay': {
        const toggle = args.trim().toLowerCase();
        if (toggle === 'on') {
          this.relayEnabled.set(channelId, true);
          await say('Output relay enabled.');
        } else if (toggle === 'off') {
          this.relayEnabled.set(channelId, false);
          await say('Output relay disabled.');
        } else {
          await say('Usage: `!relay on` or `!relay off`');
        }
        break;
      }

      case 'notify': {
        const level = args.trim().toLowerCase();
        if (level === 'silent' || level === 'normal' || level === 'verbose') {
          this.verbosityByChannel.set(channelId, level);
          this.saveVerbosity();
          await say(level === 'silent'
            ? 'Activity feed: *silent*. Permission cards and threshold alerts still post.'
            : `Activity feed: *${level}*.`);
        } else {
          await say('Usage: `!notify silent|normal|verbose`');
        }
        break;
      }

      case 'permit': {
        if (!session) { await say('No active session.'); return; }
        if (!this.opts.onPermissionGrant) { await say('Permission approval is not enabled.'); return; }
        const granted = await this.opts.onPermissionGrant(session.aisup_session_id);
        await say(granted
          ? 'Permission granted.'
          : 'No pending permission prompt to grant — it may have expired or already been resolved.');
        break;
      }

      case 'deny': {
        if (!session) { await say('No active session.'); return; }
        if (!this.opts.onPermissionDeny) { await say('Permission approval is not enabled.'); return; }
        const denied = await this.opts.onPermissionDeny(session.aisup_session_id);
        await say(denied
          ? 'Permission denied.'
          : 'No pending permission prompt to deny — it may have expired or already been resolved.');
        break;
      }

      case 'gate': {
        if (args.trim().toLowerCase() === 'status') {
          const latest = this.opts.getLatestGateRun?.();
          await say(latest ? this.formatGateSummary(latest) : 'No gate run recorded yet.');
          return;
        }
        if (!this.opts.onGateRun) { await say('Gates are not enabled.'); return; }
        await say('Running validation gates…');
        const result = await this.opts.onGateRun();
        await say(this.formatGateSummary(result));
        break;
      }

      // Worker actions are SUBCOMMANDS of `!worker` — never top-level `!approve`/`!deny`, so the
      // existing `!deny` permission command is preserved (MD-001).
      case 'worker': {
        const [sub, id] = args.trim().split(/\s+/, 2);
        const action = (sub ?? '').toLowerCase();
        if (action === 'status') {
          const workers = this.opts.getWorkerStatus?.() ?? [];
          await say(workers.length ? this.formatWorkerSummary(workers) : 'No workers.');
          return;
        }
        if (action === 'providers') {
          const report = this.opts.getWorkerProvidersView?.();
          if (!report) { await say('Workers are not enabled.'); return; }
          await this.postBlocks(channelId, 'Worker providers', providersBlocks(report));
          return;
        }
        if (action === 'diff') {
          if (!id) { await say('Usage: `!worker diff <id>`'); return; }
          const diff = this.opts.getWorkerDiff?.(id);
          if (!diff) { await say(`No diff available for worker ${id}.`); return; }
          const patch = this.redact(diff.patch);
          await say(patch ? `*${diff.title}*\n\`\`\`\n${patch.slice(0, 2800)}\n\`\`\`` : `Worker ${id}: empty patch.`);
          return;
        }
        if (action === 'approve' || action === 'deny') {
          if (!id) { await say(`Usage: \`!worker ${action} <id>\``); return; }
          const handler = action === 'approve' ? this.opts.onWorkerApprove : this.opts.onWorkerDeny;
          if (!handler) { await say('Worker actions are not enabled.'); return; }
          // Applying a worker patch mutates the workspace — gate it behind !confirm, like !stop.
          this.confirmations.set(channelId, userId, `worker_${action}`, id);
          await say(`Worker ${id}: ${action} requested. Reply \`!confirm\` within 60s to proceed.`);
          return;
        }
        if (action === 'retry') {
          if (!id) { await say('Usage: `!worker retry <id>`'); return; }
          if (!this.opts.onWorkerRetry) { await say('Worker actions are not enabled.'); return; }
          // Retry re-dispatches a NEW worker from the original task — it does not mutate the
          // workspace, so no !confirm gate (unlike approve/deny which apply a patch).
          const res = await this.opts.onWorkerRetry(id);
          await say(res.ok ? `Worker ${id}: retried → new worker \`${res.id}\`` : `Worker ${id}: retry failed (${res.reason ?? 'error'}).`);
          return;
        }
        await say('Usage: `!worker status` | `!worker providers` | `!worker diff <id>` | `!worker approve <id>` | `!worker deny <id>` | `!worker retry <id>`');
        break;
      }

      case 'accounts': {
        if (!this.opts.getAccountsView) { await say('Account readout is not available.'); return; }
        await this.postBlocks(channelId, 'Accounts', accountsBlocks(await this.opts.getAccountsView()));
        break;
      }

      case 'account': {
        // C7: runtime override — `!account pin|exclude|enable|disable|clear <name>`.
        if (!this.opts.onAccountOverride) { await say('Account overrides are not available.'); return; }
        const [sub, name] = args.trim().split(/\s+/, 2);
        const action = (sub ?? '').toLowerCase();
        if (!['pin', 'exclude', 'enable', 'disable', 'clear'].includes(action)) {
          await say('Usage: `!account pin|exclude|enable|disable <name>` | `!account clear`');
          return;
        }
        if (action !== 'clear' && !name) { await say(`Usage: \`!account ${action} <name>\``); return; }
        const res = await this.opts.onAccountOverride(action as 'pin' | 'exclude' | 'enable' | 'disable' | 'clear', name);
        await say(res.ok
          ? (action === 'clear' ? 'Account overrides cleared.' : `Account \`${name}\`: ${action} applied.`)
          : `Account override failed: ${res.error ?? 'error'}.`);
        break;
      }

      case 'pause':
      case 'resume': {
        const handler = name === 'pause' ? this.opts.onSessionPause : this.opts.onSessionResume;
        if (!handler) { await say('Pause/resume is not available.'); return; }
        const res = await handler();
        await say(res.ok
          ? (name === 'pause' ? ':pause_button: Session paused — monitoring suspended.' : ':arrow_forward: Session resumed.')
          : `Could not ${name} the session (${res.reason ?? 'error'}).`);
        break;
      }

      case 'cost': {
        if (!this.opts.getCostView) { await say('Cost readout is not available.'); return; }
        await this.postBlocks(channelId, 'Cost', costBlocks(await this.opts.getCostView()));
        break;
      }

      case 'health': {
        if (!this.opts.getHealthView) { await say('Health readout is not available.'); return; }
        await this.postBlocks(channelId, 'Health', healthBlocks(await this.opts.getHealthView()));
        break;
      }

      case 'help': {
        const lines = [
          '*aisup Slack commands:*',
          '`!interrupt` — send Ctrl+C to session',
          '`!stop` — stop session (requires `!confirm`)',
          '`!status` — show recent session output',
          '`!cmd <text>` — send text to session',
          '`!relay on|off` — toggle output relay',
          '`!notify silent|normal|verbose` — activity-feed verbosity (cards/alerts always post)',
          '`!accounts` / `!cost` / `!health` — read-only status snapshots',
          '`!worker providers` — per-role worker availability',
        ];
        if (this.opts.permissionsConfig?.enabled) {
          lines.push('Permission prompts post an interactive card — tap *Approve* / *Deny* (no typing needed)');
        }
        if (this.opts.onGateRun) {
          lines.push('`!gate` / `!gate status` — run validation gates or show the latest run');
        }
        lines.push('`!help` — show this message');
        await say(lines.join('\n'));
        break;
      }

      default:
        await say(`Unknown command: \`!${name}\`. Try \`!help\`.`);
    }
  }

  private loadChannelMap(path: string): Map<string, string> {
    if (!existsSync(path)) return new Map();
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>;
      return new Map(Object.entries(raw));
    } catch {
      return new Map();
    }
  }

  private saveChannelMap(): void {
    const { channelMapPath } = this.opts;
    mkdirSync(dirname(channelMapPath), { recursive: true, mode: 0o700 });
    const obj = Object.fromEntries(this.channelMap);
    writeFileSync(channelMapPath, JSON.stringify(obj, null, 2), { mode: 0o600 });
  }

  private startRelay(): void {
    if (this.relayHandle) return;
    this.relayHandle = setInterval(() => {
      void this.pollRelay();
    }, 10_000);
  }

  private stopRelay(): void {
    if (!this.relayHandle) return;
    clearInterval(this.relayHandle);
    this.relayHandle = null;
  }

  private async pollRelay(): Promise<void> {
    if (!this.app || !this.opts.config.relay_output_enabled) return;
    const session = this.opts.sessionManager.getActiveSession();
    if (!session) return;
    const channelId = this.channelMap.get(session.aisup_session_id);
    if (!channelId || !this.relayEnabled.get(channelId)) return;

    const path = session.output_log_path;
    let cursor = this.outputCursors.get(session.aisup_session_id);
    if (!cursor || cursor.path !== path) {
      cursor = { path, offset: 0, generation: 0 };
      this.outputCursors.set(session.aisup_session_id, cursor);
    }

    try {
      const size = statSync(path).size;
      if (size < cursor.offset) {
        cursor.offset = 0;
        cursor.generation += 1;
      }
      if (size === cursor.offset) return;
      const content = readFileSync(path, 'utf8').slice(cursor.offset);
      if (!content) {
        cursor.offset = size;
        return;
      }

      const last = this.lastPostTime.get(channelId);
      if (last !== undefined && Date.now() - last < 5000) return;

      const redacted = this.redactAndTruncate(content, 3500);
      await this.app.client.chat.postMessage({
        channel: channelId,
        text: redacted,
      });
      cursor.offset = size;
      this.lastPostTime.set(channelId, Date.now());
    } catch (err) {
      if (isRateLimited(err)) {
        await this.opts.journal.append({
          ts: new Date().toISOString(),
          event_type: 'slack.rate_limited',
          aisup_session_id: session.aisup_session_id,
          details: { retry_after_s: rateLimitRetryAfter(err), channel: channelId },
        });
      } else {
        await this.opts.journal.append({
          ts: new Date().toISOString(),
          event_type: 'slack.queue_dropped',
          aisup_session_id: session.aisup_session_id,
          details: { reason: 'relay_poll_failed', error: String(err).slice(0, 300) },
        });
      }
    }
  }

  private redactAndTruncate(text: string, maxLen: number): string {
    const redacted = redactSecrets(text, this.redactionPatterns);
    if (redacted.length <= maxLen) return redacted;
    return redacted.slice(0, maxLen - 20) + '\n[truncated]';
  }
}
