import { writeFileSync, readFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
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
import type { SlackConfig, PermissionsConfig } from '../config/schema.js';
import type { JournalWriter } from '../journal/types.js';
import type { SessionState } from '../session/types.js';
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
  channelMapPath: string;
  permissionsConfig?: PermissionsConfig;
  /** Resolve a Slack-routed permission via !permit; resolves true only when the keystroke was sent. */
  onPermissionGrant?: (sessionId: string) => boolean | Promise<boolean>;
  /** Resolve a Slack-routed permission via !deny; resolves true only when the keystroke was sent. */
  onPermissionDeny?: (sessionId: string) => boolean | Promise<boolean>;
  /** Run the configured validation gates (Slack !gate). */
  onGateRun?: () => Promise<GateRunResult>;
  /** Latest gate run for Slack !gate status. */
  getLatestGateRun?: () => GateRunResult | null;
  /** Approve a worker patch via `!worker approve <id>` — resolves ok only on a real transition. */
  onWorkerApprove?: (id: string) => Promise<{ ok: boolean; reason?: string }>;
  /** Deny a worker patch via `!worker deny <id>` — resolves ok only on a real transition. */
  onWorkerDeny?: (id: string) => Promise<{ ok: boolean; reason?: string }>;
  /** Current worker states for `!worker status`. */
  getWorkerStatus?: () => WorkerState[];
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

  constructor(opts: SlackServiceOpts) {
    this.opts = opts;
    this.redactionPatterns = opts.config.redaction_patterns.flatMap((p) => {
      try { return [new RegExp(p, 'gi')]; } catch { return []; }
    });
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

    await this.app.start();
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
      } catch { /* user may already be member */ }
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

    try {
      await this.app.client.chat.postMessage({
        channel: channelId,
        text: `Session \`${sessionId}\` has ended.`,
      });
    } catch { /* best effort */ }
  }

  /** Notify the session channel that the session is EXHAUSTED (no failover target available). */
  async onSessionExhausted(sessionId: string, reason: string): Promise<void> {
    if (!this.app) return;
    const channelId = this.channelMap.get(sessionId);
    if (!channelId) return;

    try {
      await this.app.client.chat.postMessage({
        channel: channelId,
        text: `:warning: Session \`${sessionId}\` is EXHAUSTED — no eligible failover account is available (reason: ${reason}).`,
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

  /** Post a detected permission prompt to the session's channel for an `!permit`/`!deny` decision. */
  async notifyPermissionRequest(sessionId: string, request: PermissionRequest): Promise<void> {
    if (!this.app) return;
    const channelId = this.channelMap.get(sessionId);
    if (!channelId) return;
    try {
      await this.app.client.chat.postMessage({
        channel: channelId,
        text: `:lock: Claude is requesting permission: \`${request.tool}: ${this.redactAndTruncate(request.detail, 200)}\`\nReply \`!permit\` to allow or \`!deny\` to deny.`,
      });
    } catch { /* best effort */ }
  }

  private formatGateSummary(result: GateRunResult): string {
    const head = `Gates: ${result.passed ? ':white_check_mark: PASSED' : ':x: FAILED'}`;
    const failed = result.results.filter((r) => r.status !== 'passed').map((r) => `${r.name} (${r.status})`);
    return failed.length ? `${head}\nFailed: ${failed.join(', ')}` : head;
  }

  private formatWorkerSummary(workers: WorkerState[]): string {
    return ['*Workers:*', ...workers.map((w) => `\`${w.task.id}\` ${w.status} — ${w.task.title}`)].join('\n');
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
        if (action === 'approve' || action === 'deny') {
          if (!id) { await say(`Usage: \`!worker ${action} <id>\``); return; }
          const handler = action === 'approve' ? this.opts.onWorkerApprove : this.opts.onWorkerDeny;
          if (!handler) { await say('Worker actions are not enabled.'); return; }
          // Applying a worker patch mutates the workspace — gate it behind !confirm, like !stop.
          this.confirmations.set(channelId, userId, `worker_${action}`, id);
          await say(`Worker ${id}: ${action} requested. Reply \`!confirm\` within 60s to proceed.`);
          return;
        }
        await say('Usage: `!worker status` | `!worker approve <id>` | `!worker deny <id>`');
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
        ];
        if (this.opts.permissionsConfig?.enabled) {
          lines.push('`!permit` / `!deny` — approve or deny a pending permission prompt');
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
