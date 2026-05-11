import Fastify from 'fastify';
import { readFile } from 'node:fs/promises';
import { existsSync, statSync, accessSync, constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { canStartNewSession } from '../cli/pid.js';
import type { SessionInfo, SessionState } from '../session/types.js';
import type { SessionManager } from '../session/manager.js';
import type { AccountRegistry } from '../accounts/registry.js';
import type { JournalWriter } from '../journal/types.js';
import { validateManualFailoverTarget, performSwitch } from '../failover/switcher.js';
import { SwitchReason } from '../failover/types.js';
import { buildLaunchCommand, buildResumeCommand } from '../runner/builder.js';
import type { RunnerConfig } from '../config/schema.js';
import { readEvents } from '../journal/reader.js';

export interface DaemonServerOptions {
  tokenPath: string;
  host: string;
  port: number;
  sessionManager?: SessionManager;
  accountRegistry?: AccountRegistry;
  journal?: JournalWriter;
  journalPath?: string;
  runnerConfig?: { command: string; args: string[]; env: Record<string, string> };
  runner?: RunnerConfig;
  onSessionStart?: (session: SessionState) => Promise<void> | void;
  onSessionStop?: (session: SessionState, force: boolean) => Promise<void> | void;
}

declare module 'fastify' {
  interface FastifyInstance {
    setReady(): void;
    setSessionState(session: SessionInfo | Partial<SessionState> | null): void;
  }
}

export async function createDaemonServer(opts: DaemonServerOptions): Promise<FastifyInstance> {
  let ready = false;
  let sessionState: SessionInfo | Partial<SessionState> | null = null;
  let bearerToken: string | null = null;

  if (existsSync(opts.tokenPath)) {
    bearerToken = (await readFile(opts.tokenPath, 'utf8')).trim();
  }

  const app = Fastify({ logger: false });

  // Expose test helpers on the instance
  app.decorate('setReady', () => { ready = true; });
  app.decorate('setSessionState', (s: SessionInfo | null) => { sessionState = s; });

  // Auth check — skipped for /api/health
  app.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.url === '/api/health') return;

    if (!ready) {
      return reply.status(503).send({ error: 'daemon_starting', message: 'Daemon is starting. Retry shortly.' });
    }

    const auth = req.headers.authorization ?? '';
    const tok = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!bearerToken || tok !== bearerToken) {
      return reply.status(401).send({ error: 'unauthorized' });
    }
  });

  app.get('/api/health', async (_req, reply) => {
    return reply.send({ pid: process.pid, port: opts.port, startedAt: new Date().toISOString(), ready });
  });

  app.get('/api/status', async (_req, reply) => {
    return reply.send({ session: sessionState });
  });

  app.post('/api/sessions', async (req, reply) => {
    const blockingSession = opts.sessionManager?.getBlockingSession?.() ?? (sessionState as SessionInfo | null);
    const check = canStartNewSession(blockingSession);
    if (!check.allowed) {
      const isExhausted = blockingSession?.status === 'EXHAUSTED';
      return reply.status(409).send({ error: check.reason, exhausted: isExhausted });
    }

    const body = req.body as { cwd?: string; plan?: string } | undefined;
    const cwd = resolve(body?.cwd ?? process.cwd());

    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
      return reply.status(400).send({ error: `cwd does not exist or is not a directory: ${cwd}` });
    }
    let planPath: string | null = null;
    if (body?.plan) {
      planPath = resolve(body.plan);
      try {
        accessSync(planPath, constants.R_OK);
        if (!statSync(planPath).isFile()) throw new Error('not a file');
      } catch {
        return reply.status(400).send({ error: `plan does not exist or is not readable: ${planPath}` });
      }
    }

    if (!opts.sessionManager || !opts.accountRegistry || (!opts.runnerConfig && !opts.runner)) {
      return reply.status(201).send({ status: 'created', cwd, message: 'deps not wired' });
    }

    const accounts = opts.accountRegistry.getAll();
    const bestAccount = accounts.sort((a, b) => a.priority - b.priority).find((a) => a.enabled && a.state !== 'UNAVAILABLE');
    if (!bestAccount) {
      return reply.status(409).send({ error: 'no eligible account available' });
    }

    const aisupSessionId = randomUUID();
    const launchCommand = opts.runner
      ? buildLaunchCommand(opts.runner, bestAccount.configDir)
      : opts.runnerConfig!;
    try {
      const state = await opts.sessionManager.createSession({
        aisupSessionId,
        account: bestAccount.name,
        accountConfigDir: bestAccount.configDir,
        command: launchCommand.command,
        args: launchCommand.args,
        env: launchCommand.env,
        cwd,
        planPath,
      });
      sessionState = state;
      await opts.journal?.append({
        ts: new Date().toISOString(),
        event_type: 'session.start',
        aisup_session_id: state.aisup_session_id,
        details: { account: bestAccount.name, cwd, tmux_name: state.tmux_name, plan_path: planPath },
      });
      await opts.onSessionStart?.(state);
      return reply.status(201).send({ status: 'created', aisup_session_id: state.aisup_session_id, account: bestAccount.name, cwd });
    } catch (err) {
      return reply.status(500).send({ error: `session creation failed: ${String(err)}` });
    }
  });

  app.delete('/api/sessions', async (req, reply) => {
    if (!sessionState?.aisup_session_id || !opts.sessionManager) {
      return reply.send({ status: 'stopped', message: 'no active session' });
    }
    const body = req.body as { force?: boolean } | undefined;
    const force = body?.force === true;
    const state = opts.sessionManager.readState(sessionState.aisup_session_id);
    if (state) {
      await opts.sessionManager.stopSession(state.tmux_name, state.aisup_session_id, { force });
      await opts.journal?.append({
        ts: new Date().toISOString(),
        event_type: 'session.stop',
        aisup_session_id: state.aisup_session_id,
        details: { reason: 'user_requested', force, account: state.account, cwd: state.cwd },
      });
      await opts.onSessionStop?.(state, force);
    }
    sessionState = null;
    return reply.send({ status: 'stopped' });
  });

  app.get('/api/events', async (req, reply) => {
    const query = req.query as { limit?: string; type?: string; since?: string };
    const limit = parseInt(query.limit ?? '20', 10);
    if (!opts.journalPath) return reply.send({ events: [], limit });
    const events = await readEvents(opts.journalPath, { limit, type: query.type, since: query.since });
    return reply.send({ events, limit });
  });

  app.get('/api/accounts', async (_req, reply) => {
    if (!opts.accountRegistry) {
      return reply.send({ accounts: [] });
    }
    const accounts = opts.accountRegistry.getAll().map((a) => ({
      name: a.name, state: a.state, priority: a.priority, enabled: a.enabled, score: a.score,
    }));
    return reply.send({ accounts });
  });

  app.post('/api/failover', async (req, reply) => {
    const body = req.body as { target_account?: string } | undefined;
    if (!body?.target_account) {
      return reply.status(400).send({ error: 'target_account required' });
    }
    if (!sessionState || sessionState.status === 'STOPPED') {
      return reply.status(409).send({ error: 'No active session to failover' });
    }
    if (!opts.accountRegistry || !opts.sessionManager || !opts.journal || (!opts.runnerConfig && !opts.runner)) {
      return reply.send({ target_account: body.target_account, launch_mode: 'pending', status: 'initiated' });
    }

    const accounts = opts.accountRegistry.getAll();
    const currentAccount = opts.sessionManager.readState(sessionState.aisup_session_id!)?.account;
    if (!currentAccount) {
      return reply.status(409).send({ error: 'cannot determine current account' });
    }
    const validation = validateManualFailoverTarget(body.target_account, currentAccount, accounts);
    if (!validation.valid) {
      return reply.status(400).send({ error: validation.reason });
    }

    const currentState = opts.sessionManager.readState(sessionState.aisup_session_id!);
    const result = await performSwitch(
      {
        aisupSessionId: sessionState.aisup_session_id!,
        claudeSessionId: currentState?.claude_session_id ?? null,
        transcriptPath: currentState?.transcript_path ?? null,
        activeSkill: currentState?.active_skill ?? null,
        planFilePath: currentState?.plan_path ?? null,
        sourceAccount: currentAccount,
        targetAccount: body.target_account,
        reason: SwitchReason.Manual,
        selectionMode: 'manual',
      },
      accounts,
      {
        sessionManager: opts.sessionManager,
        journal: opts.journal,
        createSessionForTarget: async (target, snapshot) => {
          const commandForTarget = opts.runner
            ? (snapshot.claudeSessionId
              ? buildResumeCommand(opts.runner, target.configDir, snapshot.claudeSessionId)
              : buildLaunchCommand(opts.runner, target.configDir))
            : opts.runnerConfig!;
          return opts.sessionManager!.createSession({
            aisupSessionId: snapshot.aisupSessionId,
            account: target.name,
            accountConfigDir: target.configDir,
            command: commandForTarget.command,
            args: commandForTarget.args,
            env: commandForTarget.env,
            cwd: currentState?.cwd ?? process.cwd(),
            planPath: snapshot.planFilePath,
          });
        },
      }
    );

    if (result.status === 'completed') {
      const nextState = opts.sessionManager.readState(sessionState.aisup_session_id!);
      sessionState = nextState ?? { status: 'ACTIVE', aisup_session_id: sessionState.aisup_session_id };
      return reply.send({ target_account: result.targetAccount, launch_mode: 'switched', status: 'completed' });
    }
    return reply.status(503).send({ error: result.error, tried: result.triedAccounts, status: result.status });
  });

  return app;
}
