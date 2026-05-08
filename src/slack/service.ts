import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
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
import type { SlackConfig } from '../config/schema.js';
import type { JournalWriter } from '../journal/types.js';
import type { SessionState } from '../session/types.js';

export interface SlackServiceOpts {
  config: SlackConfig;
  sessionManager: {
    getActiveSession(): SessionState | null;
    stopSession(tmuxName: string, sessionId: string, opts: { force?: boolean }): Promise<void>;
  };
  tmuxSocket: string;
  journal: JournalWriter;
  channelMapPath: string;
}

export class SlackService {
  private opts: SlackServiceOpts;
  private app: App | null = null;
  private channelMap = new Map<string, string>(); // sessionId → channelId
  private relayEnabled = new Map<string, boolean>(); // channelId → relay on/off
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
  }

  async stop(): Promise<void> {
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
          nameSuffix++;
        } else {
          await this.opts.journal.append({
            ts: new Date().toISOString(),
            event_type: 'slack.channel_name_collision',
            aisup_session_id: session.aisup_session_id,
            details: { error: String(err) },
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

  getChannelId(sessionId: string): string | null {
    return this.channelMap.get(sessionId) ?? null;
  }

  private async handleMessage(
    message: Record<string, unknown>,
    say: (text: string) => Promise<void>
  ): Promise<void> {
    // Ignore bot messages (echo prevention)
    if (isBotMessage(message as Parameters<typeof isBotMessage>[0])) return;

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
    if (!cmd) return; // not a command — no relay in Phase 1

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
          await say(`Sent: \`${pendingCmd.payload}\``);
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
          await say(`Will send: \`${args}\`. Reply \`!confirm\` within 60s.`);
          return;
        }
        sendText(tmuxSocket, session.tmux_name, args);
        sendEnter(tmuxSocket, session.tmux_name);
        await say(`Sent: \`${args}\``);
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

      case 'help': {
        await say([
          '*aisup Slack commands:*',
          '`!interrupt` — send Ctrl+C to session',
          '`!stop` — stop session (requires `!confirm`)',
          '`!status` — show recent session output',
          '`!cmd <text>` — send text to session',
          '`!relay on|off` — toggle output relay',
          '`!help` — show this message',
        ].join('\n'));
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
}
