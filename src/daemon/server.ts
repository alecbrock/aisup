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
import { aggregateCosts, breakdownCosts } from '../cost/aggregator.js';
import { renderDashboardPage } from '../dashboard/page.js';
import type { GateRunResult } from '../gates/types.js';
import { buildAccountsView } from '../accounts/view.js';
import type { UsageLedger } from '../accounts/usage-ledger.js';
import type { WorkerState } from '../workers/types.js';
import type { DispatchInput } from '../workers/orchestrator.js';
import type { ProviderUsageReport } from '../providers/report.js';

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

export interface ActivityHookRequest {
  toolName: string;
  toolInput: unknown;
  toolResponse: unknown;
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
  /** Claude Code PostToolUse hook: structured tool activity for the live Slack feed (fire-and-forget). */
  onActivityHook?: (req: ActivityHookRequest) => void;
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
  /** C6: re-dispatch a terminal-failed worker; resolves with the new worker id on success. */
  retryWorker?: (id: string) => Promise<{ ok: boolean; reason?: string; id?: string }>;
  /** C10: revert a merged worker's patch; list/remove orphaned worktrees. */
  undoWorker?: (id: string) => Promise<{ ok: boolean; reason?: string }>;
  cleanupWorktrees?: (force: boolean) => Promise<{ orphans: string[]; removed: string[] }>;
  /** Per-provider usage readout for GET /api/workers/providers. */
  getWorkerProviders?: () => ProviderUsageReport;
  /** D3: per-loop liveness for /api/health (loop → last tick + staleness). */
  getLoopHealth?: () => Array<{ loop: string; last_tick: string | null; stale: boolean }>;
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

  // D1 dashboard cookies: opaque value → expiry(ms). A read-only-scoped credential minted by exchanging
  // the bearer token; it authorizes ONLY the read-only /api/overview, never a control route.
  const DASHBOARD_TTL_MS = 30 * 60 * 1000;
  const dashboardCookies = new Map<string, number>();
  const COOKIE_NAME = 'aisup_dash';
  const mintDashboardCookie = (): string => {
    const value = randomUUID();
    dashboardCookies.set(value, Date.now() + DASHBOARD_TTL_MS);
    return value;
  };
  const validDashboardCookie = (req: FastifyRequest): boolean => {
    const header = req.headers.cookie ?? '';
    const match = header.split(';').map((c) => c.trim()).find((c) => c.startsWith(`${COOKIE_NAME}=`));
    if (!match) return false;
    const value = match.slice(COOKIE_NAME.length + 1);
    const exp = dashboardCookies.get(value);
    if (!exp) return false;
    if (Date.now() > exp) { dashboardCookies.delete(value); return false; }
    return true;
  };
  // Routes reachable with a dashboard cookie (read-only). Everything else needs the bearer header.
  const COOKIE_ALLOWED = new Set(['/api/overview']);
  // Routes that self-handle auth (no preHandler bearer check).
  const OPEN_ROUTES = new Set(['/api/health', '/dashboard', '/api/dashboard/session']);

  // Expose test helpers on the instance
  app.decorate('setReady', () => { ready = true; });
  app.decorate('setSessionState', (s: SessionInfo | null) => { sessionState = s; });

  // Auth check — bearer header for control routes; bearer OR read-only cookie for /api/overview.
  app.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    const path = req.url.split('?')[0];
    if (OPEN_ROUTES.has(path)) return;

    if (!ready) {
      return reply.status(503).send({ error: 'daemon_starting', message: 'Daemon is starting. Retry shortly.' });
    }

    const auth = req.headers.authorization ?? '';
    const tok = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (bearerToken && tok === bearerToken) return;
    // Read-only cookie is accepted ONLY for cookie-allowed routes (never control routes).
    if (COOKIE_ALLOWED.has(path) && validDashboardCookie(req)) return;
    return reply.status(401).send({ error: 'unauthorized' });
  });

  app.get('/api/health', async (_req, reply) => {
    const loops = opts.getLoopHealth?.() ?? [];
    return reply.send({ pid: process.pid, port: opts.port, startedAt: new Date().toISOString(), ready, loops });
  });

  // D1: unauthenticated read-only dashboard shell (the token is pasted in-page, never in the URL).
  app.get('/dashboard', async (_req, reply) => {
    return reply.type('text/html; charset=utf-8').send(renderDashboardPage());
  });

  // D1: exchange the bearer token (in the BODY, not a URL) for a short-lived HttpOnly read-only cookie.
  app.post('/api/dashboard/session', async (req, reply) => {
    const provided = ((req.body ?? {}) as { token?: string }).token ?? '';
    if (!bearerToken || provided !== bearerToken) return reply.status(401).send({ error: 'unauthorized' });
    const value = mintDashboardCookie();
    reply.header('set-cookie', `${COOKIE_NAME}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${DASHBOARD_TTL_MS / 1000}`);
    return reply.send({ ok: true });
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

  // Unified one-shot snapshot (C1): session + per-account headroom + worker queue + cost-today +
  // recent events, in ONE response. Composes the SAME readers as /api/status, /api/accounts,
  // /api/cost, /api/workers, /api/events (no new aggregation). Backs `aisup health`/`watch`, Slack
  // `!health`, and the dashboard.
  app.get('/api/overview', async (_req, reply) => {
    let session: SessionInfo | Partial<SessionState> | null = sessionState;
    const id = sessionState?.aisup_session_id;
    if (id && typeof opts.sessionManager?.readState === 'function') {
      const fresh = opts.sessionManager.readState(id);
      if (fresh) session = fresh;
    }

    let accounts: ReturnType<typeof buildAccountsView> = [];
    if (opts.accountRegistry) {
      await opts.refreshAccounts?.();
      accounts = buildAccountsView({
        accountRegistry: opts.accountRegistry,
        usageLedger: opts.usageLedger,
        statuslineDir: opts.statuslineDir,
        freshnessWindowS: opts.statuslineFreshnessWindowS,
        nowMs: Date.now(),
      });
    }

    const workerList = opts.listWorkers?.() ?? null;
    const workers = workerList
      ? {
          total: workerList.length,
          queued: workerList.filter((w) => w.status === 'QUEUED').length,
          running: workerList.filter((w) => w.status === 'RUNNING').length,
          awaiting_approval: workerList.filter((w) => w.status === 'AWAITING_APPROVAL').length,
        }
      : null;

    const cost = opts.journalPath
      ? (await aggregateCosts({ journalPath: opts.journalPath })).today
      : { total_cost_usd: 0, by_account: {}, by_session: {} };

    const recent_events = opts.journalPath ? await readEvents(opts.journalPath, { limit: 10 }) : [];

    return reply.send({
      session,
      recovery_guidance: session?.status ? recoveryGuidance(session.status) : null,
      accounts,
      workers,
      cost_today: cost,
      recent_events,
      daemon: { ok: true, loops: opts.getLoopHealth?.() ?? [] },
    });
  });

  app.post('/api/sessions', async (req, reply) => {
    const blockingSession = opts.sessionManager?.getBlockingSession?.() ?? (sessionState as SessionInfo | null);
    const check = canStartNewSession(blockingSession);
    if (!check.allowed) {
      const isExhausted = blockingSession?.status === 'EXHAUSTED';
      return reply.status(409).send({ error: check.reason, exhausted: isExhausted });
    }

    const body = req.body as { cwd?: string; plan?: string; name?: string } | undefined;
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
      // Fail loudly (AF-327): a misconfigured daemon must NOT report a phantom "created" session.
      return reply.status(503).send({ error: 'session dependencies not configured' });
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
        command: launchCommand.command,
        args: launchCommand.args,
        env: launchCommand.env,
        cwd,
        planPath,
        name: body?.name,
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

  // C9: pause/resume the active session (SIGSTOP/SIGCONT its runner). PAUSED suspends monitoring.
  const sessionSignalRoute = (verb: 'pause' | 'resume') => async (_req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    if (!opts.sessionManager) return reply.code(503).send({ error: 'no session manager' });
    const id = sessionState?.aisup_session_id;
    if (!id) return reply.status(409).send({ error: 'no active session' });
    const res = verb === 'pause'
      ? await opts.sessionManager.pauseSession(id)
      : await opts.sessionManager.resumeSession(id);
    if (!res.ok) return reply.status(409).send({ ok: false, error: res.reason });
    const fresh = opts.sessionManager.readState(id);
    if (fresh) sessionState = fresh;
    return reply.send({ ok: true, status: fresh?.status });
  };
  app.post('/api/sessions/pause', sessionSignalRoute('pause'));
  app.post('/api/sessions/resume', sessionSignalRoute('resume'));

  // C11: label a session for readability.
  app.post('/api/sessions/rename', async (req, reply) => {
    if (!opts.sessionManager) return reply.code(503).send({ error: 'no session manager' });
    const { id, name } = (req.body ?? {}) as { id?: string; name?: string };
    if (!id || !name) return reply.status(400).send({ error: 'id and name required' });
    const res = opts.sessionManager.renameSession(id, name);
    if (!res.ok) return reply.status(404).send({ ok: false, error: res.reason });
    if (sessionState?.aisup_session_id === id) {
      const fresh = opts.sessionManager.readState(id);
      if (fresh) sessionState = fresh;
    }
    return reply.send({ ok: true });
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
    const query = req.query as { limit?: string; type?: string; since?: string; account?: string; session?: string };
    const limit = parseInt(query.limit ?? '20', 10);
    if (!opts.journalPath) return reply.send({ events: [], limit });
    const events = await readEvents(opts.journalPath, {
      limit, type: query.type, since: query.since, account: query.account, session: query.session,
    });
    return reply.send({ events, limit });
  });

  app.get('/api/cost', async (req, reply) => {
    const by = (req.query as { by?: string }).by;
    if (!opts.journalPath) {
      if (by) return reply.send({ by, breakdown: {} });
      const empty = { total_cost_usd: 0, by_account: {}, by_session: {} };
      return reply.send({ today: empty, last_7d: empty, last_30d: empty });
    }
    if (by === 'account' || by === 'skill' || by === 'provider' || by === 'task') {
      const events = await readEvents(opts.journalPath, {});
      return reply.send({ by, breakdown: breakdownCosts(events, by) });
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
    // Validate shape/size (AF-327): reject wrong-typed fields and an oversized tool_input payload
    // before it is forwarded to the broker / posted to Slack.
    if (body.tool_name !== undefined && typeof body.tool_name !== 'string') {
      return reply.status(400).send({ error: 'tool_name must be a string' });
    }
    if (body.session_id !== undefined && typeof body.session_id !== 'string') {
      return reply.status(400).send({ error: 'session_id must be a string' });
    }
    if (body.tool_input !== undefined && body.tool_input !== null) {
      let inputSize: number;
      try {
        inputSize = JSON.stringify(body.tool_input).length;
      } catch {
        return reply.status(400).send({ error: 'tool_input is not serializable' });
      }
      if (inputSize > 100_000) {
        return reply.status(413).send({ error: 'tool_input exceeds 100000 bytes' });
      }
    }
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

  // PostToolUse → the live activity feed. Fire-and-forget: validate shape/size, hand to the daemon,
  // and return immediately (a slow Slack post must never stall the session).
  app.post('/api/hooks/activity', async (req, reply) => {
    const body = (req.body ?? {}) as { tool_name?: string; tool_input?: unknown; tool_response?: unknown; session_id?: string };
    if (body.tool_name !== undefined && typeof body.tool_name !== 'string') {
      return reply.status(400).send({ error: 'tool_name must be a string' });
    }
    if (body.session_id !== undefined && typeof body.session_id !== 'string') {
      return reply.status(400).send({ error: 'session_id must be a string' });
    }
    if (body.tool_input !== undefined && body.tool_input !== null) {
      let inputSize: number;
      try {
        inputSize = JSON.stringify(body.tool_input).length;
      } catch {
        return reply.status(400).send({ error: 'tool_input is not serializable' });
      }
      if (inputSize > 100_000) {
        return reply.status(413).send({ error: 'tool_input exceeds 100000 bytes' });
      }
    }
    if (body.tool_name) {
      opts.onActivityHook?.({
        toolName: body.tool_name,
        toolInput: body.tool_input ?? null,
        toolResponse: body.tool_response ?? null,
        claudeSessionId: body.session_id ?? null,
      });
    }
    return reply.send({ ok: true });
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

  app.get('/api/workers/providers', async (_req, reply) => {
    if (!opts.getWorkerProviders) return reply.code(503).send({ error: 'workers not enabled' });
    return reply.send(opts.getWorkerProviders());
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

  app.post('/api/workers/:id/retry', async (req, reply) => {
    if (!opts.retryWorker) return reply.code(503).send({ error: 'workers not enabled' });
    const { id } = req.params as { id: string };
    const result = await opts.retryWorker(id);
    if (result.ok) return reply.send({ ok: true, id: result.id });
    const code = result.reason === 'not_found' ? 404 : 409;
    return reply.status(code).send({ ok: false, error: result.reason ?? 'failed' });
  });

  app.post('/api/workers/:id/undo', async (req, reply) => {
    if (!opts.undoWorker) return reply.code(503).send({ error: 'workers not enabled' });
    const { id } = req.params as { id: string };
    const result = await opts.undoWorker(id);
    if (result.ok) return reply.send({ ok: true });
    const code = result.reason === 'not_found' ? 404 : 409;
    return reply.status(code).send({ ok: false, error: result.reason ?? 'failed' });
  });

  app.post('/api/workers/cleanup', async (req, reply) => {
    if (!opts.cleanupWorktrees) return reply.code(503).send({ error: 'workers not enabled' });
    const force = ((req.body ?? {}) as { force?: boolean }).force === true;
    return reply.send(await opts.cleanupWorktrees(force));
  });

  app.get('/api/accounts', async (_req, reply) => {
    if (!opts.accountRegistry) {
      return reply.send({ accounts: [] });
    }
    // Refresh first so scores/state + the ledger reflect the latest live telemetry and decay.
    await opts.refreshAccounts?.();
    const accounts = buildAccountsView({
      accountRegistry: opts.accountRegistry,
      usageLedger: opts.usageLedger,
      statuslineDir: opts.statuslineDir,
      freshnessWindowS: opts.statuslineFreshnessWindowS,
      nowMs: Date.now(),
    });
    return reply.send({ accounts });
  });

  // C7: runtime account overrides — pin/exclude/enable/disable/clear without a config edit + restart.
  app.post('/api/accounts/:name/override', async (req, reply) => {
    if (!opts.accountRegistry) return reply.code(503).send({ error: 'no account registry' });
    const { name } = req.params as { name: string };
    const body = (req.body ?? {}) as { pin?: boolean; exclude?: boolean; enable?: boolean; disable?: boolean; clear?: boolean };
    if (body.clear) {
      opts.accountRegistry.clearOverrides();
      await opts.refreshAccounts?.();
      return reply.send({ ok: true, cleared: true });
    }
    if (!opts.accountRegistry.get(name)) return reply.status(404).send({ error: `unknown account "${name}"` });
    if (body.pin) opts.accountRegistry.setOverride(name, { pinned: true });
    else if (body.exclude) opts.accountRegistry.setOverride(name, { excluded: true });
    else if (body.enable) opts.accountRegistry.setOverride(name, { enabled: true });
    else if (body.disable) opts.accountRegistry.setOverride(name, { enabled: false });
    else return reply.status(400).send({ error: 'one of pin|exclude|enable|disable|clear required' });
    await opts.refreshAccounts?.();
    return reply.send({ ok: true, account: name });
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
