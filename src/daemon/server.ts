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
import { validateManualFailoverTarget, performSwitch, selectSwitchTarget } from '../failover/switcher.js';
import type { LaunchMode } from '../failover/switcher.js';
import { SwitchReason } from '../failover/types.js';
import type { SwitchSnapshot } from '../failover/types.js';
import type { AccountInfo } from '../accounts/types.js';
import { buildLaunchCommand, buildResumeCommand } from '../runner/builder.js';
import type { RunnerConfig } from '../config/schema.js';
import { readEvents } from '../journal/reader.js';
import { aggregateCosts } from '../cost/aggregator.js';
import type { GateRunResult } from '../gates/types.js';
import { readTelemetryForAccount } from '../statusline/store.js';
import type { UsageLedger } from '../accounts/usage-ledger.js';
import type { WorkerState } from '../workers/types.js';
import type { DispatchInput } from '../workers/orchestrator.js';

export interface WorkerActionResult {
  ok: boolean;
  reason?: string;
}

/** A Claude Code PermissionRequest hook payload, normalized for the broker. */
export interface PermissionHookRequest {
  toolName: string;
  toolInput: unknown;
  claudeSessionId: string | null;
}

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
  /** Canonical target launcher (resume/fresh + continuation injection). When provided, /api/failover
   *  uses it so the manual path matches the automatic path exactly (no divergent launch logic). */
  createSessionForTarget?: (target: AccountInfo, snapshot: SwitchSnapshot, launchMode: LaunchMode) => Promise<SessionState>;
  /** Refresh account scores/state from telemetry + circuit breaker before an automatic selection. */
  refreshAccounts?: () => void | Promise<void>;
  /** Statusline telemetry source for /api/accounts usage/model parity with offline `aisup accounts`. */
  statuslineDir?: string;
  statuslineFreshnessWindowS?: number;
  /** Usage ledger: /api/accounts reports decayed best-estimate usage + freshness basis from it. */
  usageLedger?: UsageLedger;
  /** Emit a final cost snapshot at a lifecycle boundary (pre-stop / pre-manual-failover). */
  captureCostSnapshot?: (sessionId: string, trigger: string) => void;
  /** Drop a session's cost tracking on terminal stop. */
  clearCostTracking?: (sessionId: string) => void;
  /** Claude Code UserPromptExpansion hook: a skill/slash-command was invoked in the session. */
  onSkillHook?: (commandName: string, claudeSessionId: string | null) => void;
  /** Claude Code PermissionRequest hook: 'allow'/'deny' to decide, or null to defer to the dialog
   *  (the ask-path posts to Slack and is resolved later by a keystroke — non-blocking). */
  onPermissionHook?: (req: PermissionHookRequest) => Promise<'allow' | 'deny' | null>;
  /** Run the configured validation gates (manual trigger from API/Slack/CLI). */
  runGates?: () => Promise<GateRunResult>;
  /** Latest gate run for GET /api/gates. */
  getLatestGateRun?: () => GateRunResult | null;
  /** Worker orchestrator handlers (injected when workers.enabled); absent ⇒ 503 from /api/workers. */
  dispatchWorker?: (input: DispatchInput) => Promise<string>;
  listWorkers?: () => WorkerState[];
  getWorker?: (id: string) => WorkerState | null;
  approveWorker?: (id: string, by: string) => Promise<WorkerActionResult>;
  denyWorker?: (id: string, by: string) => Promise<WorkerActionResult>;
  cancelWorker?: (id: string) => Promise<WorkerActionResult>;
}

declare module 'fastify' {
  interface FastifyInstance {
    setReady(): void;
    setSessionState(session: SessionInfo | Partial<SessionState> | null): void;
  }
}

/** Human-readable recovery guidance per session status for the status surface. */
function recoveryGuidance(status: SessionState['status']): string {
  switch (status) {
    case 'EXHAUSTED':
      return 'No eligible failover account is available. Auto-resume will retry when an account becomes runnable; otherwise stop the session or run a manual failover.';
    case 'SWITCHING':
      return 'A failover is in progress.';
    case 'SWITCH_PENDING_AT_IDLE':
      return 'A soft-threshold switch is pending until the session goes idle.';
    case 'CREATING':
      return 'The session is starting.';
    case 'STOPPING':
      return 'The session is stopping.';
    case 'STOPPED':
      return 'The session has stopped.';
    case 'ACTIVE':
    default:
      return 'The session is active.';
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
    // Read the freshest persisted state on request so skill detection and failover/EXHAUSTED
    // transitions (which loop-manager patches to disk) are visible, not a stale in-memory copy.
    let session: SessionInfo | Partial<SessionState> | null = sessionState;
    const id = sessionState?.aisup_session_id;
    if (id && typeof opts.sessionManager?.readState === 'function') {
      const fresh = opts.sessionManager.readState(id);
      if (fresh) session = fresh;
    }
    const recovery_guidance = session?.status ? recoveryGuidance(session.status) : null;
    return reply.send({ session, recovery_guidance });
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

    // Refresh scores/state from telemetry + circuit breaker, then use the canonical
    // selector so admission honours scoring and excludes UNAVAILABLE/COOLDOWN accounts.
    await opts.refreshAccounts?.();
    const accounts = opts.accountRegistry.getAll();
    const bestAccount = selectSwitchTarget(accounts, '', []);
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
      // Capture the final cost snapshot before the pane is destroyed, then clean up cost tracking.
      opts.captureCostSnapshot?.(state.aisup_session_id, 'pre_stop');
      await opts.sessionManager.stopSession(state.tmux_name, state.aisup_session_id, { force });
      await opts.journal?.append({
        ts: new Date().toISOString(),
        event_type: 'session.stop',
        aisup_session_id: state.aisup_session_id,
        details: { reason: 'user_requested', force, account: state.account, cwd: state.cwd },
      });
      await opts.onSessionStop?.(state, force);
      opts.clearCostTracking?.(state.aisup_session_id);
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

  app.get('/api/cost', async (_req, reply) => {
    if (!opts.journalPath) {
      const empty = { total_cost_usd: 0, by_account: {}, by_session: {} };
      return reply.send({ today: empty, last_7d: empty, last_30d: empty });
    }
    const windows = await aggregateCosts({ journalPath: opts.journalPath });
    return reply.send(windows);
  });

  app.get('/api/gates', async (_req, reply) => {
    return reply.send({ latest: opts.getLatestGateRun?.() ?? null });
  });

  app.post('/api/gates/run', async (_req, reply) => {
    if (!opts.runGates) return reply.code(503).send({ error: 'gates not configured' });
    const result = await opts.runGates();
    return reply.send(result);
  });

  // ---- Claude Code hooks (structured detection; replaces pane-output scraping) -------------
  // UserPromptExpansion → which skill/slash-command was invoked. Fire-and-forget (200).
  app.post('/api/hooks/skill', async (req, reply) => {
    const body = (req.body ?? {}) as { command_name?: string; session_id?: string };
    if (typeof body.command_name === 'string' && body.command_name.length > 0) {
      opts.onSkillHook?.(body.command_name, body.session_id ?? null);
    }
    return reply.send({ ok: true });
  });

  // PermissionRequest → route to Slack and block until !permit/!deny (or the hook timeout). The
  // returned JSON tells Claude Code to allow or deny, so no dialog/keystroke handling is needed.
  app.post('/api/hooks/permission', async (req, reply) => {
    const body = (req.body ?? {}) as { tool_name?: string; tool_input?: unknown; session_id?: string };
    if (!opts.onPermissionHook) {
      // Broker not wired → no decision; Claude Code's own permission flow proceeds.
      return reply.send({});
    }
    const decision = await opts.onPermissionHook({
      toolName: body.tool_name ?? 'unknown',
      toolInput: body.tool_input ?? null,
      claudeSessionId: body.session_id ?? null,
    });
    // null → defer to Claude's own dialog (the ask-path resolves later via a keystroke from Slack).
    if (decision === null) return reply.send({});
    return reply.send({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        permissionDecision: decision,
        permissionDecisionReason: `aisup ${decision}`,
      },
    });
  });

  // ---- Multi-LLM workers (Phase 3) -----------------------------------------
  // POST returns immediately with 202/QUEUED — the pipeline runs in the background (MD-002).
  app.post('/api/workers', async (req, reply) => {
    if (!opts.dispatchWorker) return reply.code(503).send({ error: 'workers not enabled' });
    const body = (req.body ?? {}) as Partial<DispatchInput>;
    if (!body.task_type || !body.prompt) {
      return reply.status(400).send({ error: 'task_type and prompt are required' });
    }
    try {
      const id = await opts.dispatchWorker({
        task_type: body.task_type,
        prompt: body.prompt,
        title: body.title,
        implementer: body.implementer,
        reviewer: body.reviewer,
        base_ref: body.base_ref,
        workspace: body.workspace,
      });
      return reply.status(202).send({ id, status: 'QUEUED' });
    } catch (err) {
      return reply.status(400).send({ error: String(err instanceof Error ? err.message : err) });
    }
  });

  app.get('/api/workers', async (_req, reply) => {
    if (!opts.listWorkers) return reply.code(503).send({ error: 'workers not enabled' });
    return reply.send({ workers: opts.listWorkers() });
  });

  app.get('/api/workers/:id', async (req, reply) => {
    if (!opts.getWorker) return reply.code(503).send({ error: 'workers not enabled' });
    const { id } = req.params as { id: string };
    const worker = opts.getWorker(id);
    if (!worker) return reply.status(404).send({ error: 'worker not found' });
    return reply.send({ worker });
  });

  const workerAction = async (
    handler: ((id: string, by: string) => Promise<WorkerActionResult>) | undefined,
    req: FastifyRequest,
    reply: FastifyReply
  ): Promise<FastifyReply> => {
    if (!handler) return reply.code(503).send({ error: 'workers not enabled' });
    const { id } = req.params as { id: string };
    const by = ((req.body ?? {}) as { by?: string }).by ?? 'api';
    const result = await handler(id, by);
    if (result.ok) return reply.send({ ok: true });
    return reply.status(409).send({ ok: false, error: result.reason ?? 'failed' });
  };

  app.post('/api/workers/:id/approve', (req, reply) => workerAction(opts.approveWorker, req, reply));
  app.post('/api/workers/:id/deny', (req, reply) => workerAction(opts.denyWorker, req, reply));
  app.post('/api/workers/:id/cancel', (req, reply) =>
    workerAction(opts.cancelWorker ? (id) => opts.cancelWorker!(id) : undefined, req, reply)
  );

  app.get('/api/accounts', async (_req, reply) => {
    if (!opts.accountRegistry) {
      return reply.send({ accounts: [] });
    }
    // Refresh first so scores/state + the ledger reflect the latest live telemetry and decay.
    await opts.refreshAccounts?.();
    const slDir = opts.statuslineDir;
    const freshness = opts.statuslineFreshnessWindowS ?? 300;
    const nowMs = Date.now();
    const accounts = opts.accountRegistry.getAll().map((a) => {
      // model still comes from telemetry; usage comes from the ledger's decayed estimate.
      const telemetry = slDir ? readTelemetryForAccount(a.configDir, slDir, freshness) : null;
      const est = opts.usageLedger?.estimate(a.name, nowMs);
      const five = est ? est.five_hour.used_pct : (telemetry?.rate_limits?.five_hour?.used_percentage ?? null);
      const seven = est ? est.seven_day.used_pct : (telemetry?.rate_limits?.seven_day?.used_percentage ?? null);
      return {
        name: a.name, state: a.state, priority: a.priority, enabled: a.enabled, score: a.score,
        cooldown_until: a.cooldownUntil ? a.cooldownUntil.toISOString() : null,
        five_hour_pct: typeof five === 'number' ? five : null,
        seven_day_pct: typeof seven === 'number' ? seven : null,
        five_hour_basis: est?.five_hour.basis ?? null,
        seven_day_basis: est?.seven_day.basis ?? null,
        model: telemetry?.model?.id ?? null,
      };
    });
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
    // Capture the pre-switch final cost snapshot before performSwitch destroys the source pane.
    opts.captureCostSnapshot?.(sessionState.aisup_session_id!, 'pre_manual_failover');
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
        // Prefer the daemon's canonical launcher (continuation injection + identical resume logic) so
        // a manual `aisup failover` behaves exactly like an automatic one. Fallback is launch-only.
        createSessionForTarget: opts.createSessionForTarget ?? (async (target, snapshot, launchMode) => {
          const commandForTarget = opts.runner
            ? ((launchMode === 'resumed' && snapshot.claudeSessionId)
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
        }),
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
