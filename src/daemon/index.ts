import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { aisupHome } from '../config/paths.js';
import { mkdir, readFile } from 'node:fs/promises';
import { RotatingLog } from '../util/rotating-log.js';
import { loadConfig, resetConfigCache } from '../config/loader.js';
import { planReload } from './reload.js';
import { createJournalWriter } from '../journal/writer.js';
import { createDaemonServer } from './server.js';
import { writePidFile, removePidFile } from '../cli/pid.js';
import { LoopManager } from './loop-manager.js';
import { SessionManager } from '../session/manager.js';
import { AccountRegistry } from '../accounts/registry.js';
import { buildAccountsView } from '../accounts/view.js';
import { aggregateCosts } from '../cost/aggregator.js';
import { ThresholdAlerter } from './threshold-alert.js';
import { createNtfyEmitter } from '../notifications/ntfy.js';
import { CircuitBreaker } from '../accounts/circuit-breaker.js';
import { refreshAccountScores } from '../accounts/refresh.js';
import { UsageLedger } from '../accounts/usage-ledger.js';
import { buildLaunchCommand, buildResumeCommand, validateRunner } from '../runner/builder.js';
import { rehydrateSessions } from './rehydration.js';
import { setTmuxTimeoutHandler, sendText, sendEnter, captureOutput } from '../session/tmux.js';
import { SlackService } from '../slack/service.js';
import { RecoveryHandler } from './loops/recovery-handler.js';
import { ExhaustedRecovery, resumeExhaustedSession } from '../recovery/exhausted.js';
import { PermissionDetector } from '../permissions/detector.js';
import { PermissionBroker } from '../permissions/broker.js';
import { evaluatePermission } from '../permissions/policy.js';
import { PendingPermissionQueue } from '../permissions/pending-queue.js';
import { resolveHookPermissionViaKeystroke, type HookResolverDeps } from '../permissions/hook-resolver.js';
import type { PermissionRequest } from '../permissions/types.js';
import type { PermissionHookRequest } from './server.js';
import { writeHookSettings } from '../hooks/claude-hooks.js';
import { resolveSkillFromCommandName } from '../skills/detector.js';
import { buildContinuationPrompt } from '../skills/continuation.js';
import { runGates } from '../gates/engine.js';
import type { GateRunResult } from '../gates/types.js';
import { WorkerOrchestrator } from '../workers/orchestrator.js';
import type { WorkerRole } from '../workers/orchestrator.js';
import { WorkerStore } from '../workers/store.js';
import { validateWorkerOutput } from '../workers/validation.js';
import { reviewWorkerOutput } from '../workers/review.js';
import { mergeWorkerOutput } from '../workers/merge.js';
import { ClaudeProviderUsage } from '../providers/claude-usage.js';
import { CodexProviderUsage } from '../providers/codex-usage.js';
import { resolveCandidates } from '../providers/selector.js';
import { buildProviderUsageReport } from '../providers/report.js';
import type { ProviderUsageReport } from '../providers/report.js';
import { resolveCodexBudget } from '../config/defaults.js';
import type { ConcreteCandidate, ProviderUsage } from '../providers/types.js';
import type { WorkerTask } from '../workers/types.js';
import {
  resolveBaseSha,
  createWorktree,
  captureDiff,
  snapshotMainTree,
  auditBoundary,
  sanitizePatch,
  patchSha256,
  removeWorktree,
  isGitRepo,
  applyCheck,
  applyReverseCheck,
} from '../workers/worktree.js';
import { SwitchReason } from '../failover/types.js';
import type { SwitchSnapshot } from '../failover/types.js';
import type { LaunchMode } from '../failover/switcher.js';
import type { AccountInfo } from '../accounts/types.js';
import type { SessionState } from '../session/types.js';

// Read at import time: the daemon process has AISUP_HOME (when set) in its env before launch, so
// this captures the correct isolated state dir for the whole process lifetime (see config/paths.ts).
const AISUP_DIR = aisupHome();
const PID_PATH = join(AISUP_DIR, 'daemon.pid');
const TOKEN_PATH = join(AISUP_DIR, 'api-token');
const LOG_PATH = join(AISUP_DIR, 'daemon.log');
// The PermissionRequest hook is non-blocking (it posts to Slack and defers to Claude's dialog), so
// it returns in milliseconds — a short timeout is plenty. The human decision has no time limit: it
// arrives later as a keystroke to the persistent dialog, independent of any hook timeout.
const PERMISSION_HOOK_TIMEOUT_S = 30;

/** Human-readable summary of a tool's input for the Slack permission prompt (command/path/url first). */
function summarizeToolInput(toolInput: unknown): string {
  if (toolInput && typeof toolInput === 'object') {
    const o = toolInput as Record<string, unknown>;
    for (const key of ['command', 'file_path', 'path', 'url', 'pattern'] as const) {
      if (typeof o[key] === 'string') return o[key] as string;
    }
  }
  try {
    return JSON.stringify(toolInput) ?? 'unknown';
  } catch {
    return String(toolInput);
  }
}

async function main(): Promise<void> {
  await mkdir(AISUP_DIR, { recursive: true, mode: 0o700 });

  // Load config BEFORE wiring the rotating log so daemon.log honors the configured size (D3) — not
  // the old hard-coded 10MB. Config errors here are already caught foreground in daemonStart.
  const loadedConfig = await loadConfig();
  const config = {
    ...loadedConfig,
    runner: {
      ...loadedConfig.runner,
      command: validateRunner(loadedConfig.runner),
    },
  };

  const rotatingLog = new RotatingLog({ path: LOG_PATH, maxSizeMb: config.daemon.log_max_size_mb, maxFiles: 3 });
  process.stdout.write = (data: string | Uint8Array) => rotatingLog.write(data);
  process.stderr.write = (data: string | Uint8Array) => rotatingLog.write(data);

  const journal = createJournalWriter(config.journal.path, config.journal.max_size_mb);
  // D2: best-effort ntfy push mirror (notification-only; Slack stays the control plane).
  const emitNtfy = createNtfyEmitter({ config: config.notifications.ntfy, journal });
  const accountRegistry = new AccountRegistry(config);
  const circuitBreaker = new CircuitBreaker({
    maxFailures: config.failover.circuit_breaker_max_failures,
    cooldownSeconds: config.failover.circuit_breaker_cooldown_seconds,
    statePath: join(AISUP_DIR, 'circuit-breaker-state.json'),
  });
  const tmuxSocket = config.session.tmux_socket;

  // Persistent per-account usage ledger: captures live usage while a session is active and decays
  // idle windows to 0% once their reset passes, so scoring/selection never trusts stale telemetry.
  const usageLedger = new UsageLedger(
    join(AISUP_DIR, 'usage-ledger.json'),
    config.statusline.freshness_window_s * 1000,
  );

  // Refresh account scores/state from telemetry (via the ledger) + circuit breaker before any
  // automatic selection decision (start admission, soft/hard failover). Without this, scores stay
  // null and the canonical selector falls back to priority order, ignoring scoring.
  const refreshAccounts = (): void => refreshAccountScores({
    registry: accountRegistry,
    statuslineDir: config.statusline.directory,
    freshnessWindowS: config.statusline.freshness_window_s,
    softPct: config.thresholds.soft_pct,
    hardPct: config.thresholds.hard_pct,
    circuitBreaker,
    ledger: usageLedger,
  });

  // Install aisup-managed Claude Code hooks (structured skill + permission detection) into every
  // supervised session via `claude --settings`, then point launches at it. Additive — no edits to
  // the user's account or repo settings. The bearer token is embedded (file written 0600).
  const hooksSettingsPath = join(AISUP_DIR, 'claude-hooks.json');
  try {
    const apiToken = (await readFile(TOKEN_PATH, 'utf8')).trim();
    if (apiToken) {
      writeHookSettings(hooksSettingsPath, {
        port: config.daemon.port,
        token: apiToken,
        includeSkill: true,
        includePermission: config.permissions.enabled,
        // Live activity feed posts to Slack — only install the PostToolUse hook when Slack is on.
        includeActivity: config.slack.enabled,
        // Permissions never auto-deny — the hook waits for a human decision (24h ceiling).
        permissionTimeoutS: PERMISSION_HOOK_TIMEOUT_S,
      });
      config.runner.args = [...config.runner.args, '--settings', hooksSettingsPath];
    }
  } catch {
    // No api-token yet → skip hook install; detection falls back to existing pane-scan behavior.
  }

  const sessionManager = new SessionManager({
    tmuxSocket,
    stateDir: join(AISUP_DIR, 'sessions'),
    outputLogMaxSizeMb: config.session.output_log_max_size_mb,
    outputLogRetentionDays: config.session.output_log_retention_days,
    journal,
  });

  // Multi-LLM worker orchestrator (Phase 3) — gated by config.workers.enabled. Constructed before
  // the server so its handlers can be injected; rehydrated/started after session rehydration.
  let workerOrchestrator: WorkerOrchestrator | undefined;
  let getWorkerProviders: (() => ProviderUsageReport) | undefined;
  if (config.workers.enabled) {
    const workerStore = new WorkerStore(join(AISUP_DIR, 'workers'));

    // Multi-provider failover wiring (Part B): provider-usage signals + candidate selector, built from
    // the existing account registry, usage ledger, and circuit-breaker state. A failover-worthy failure
    // (429/quota/auth/timeout/unspawnable) marks a candidate UNAVAILABLE for the circuit-breaker cooldown
    // window — the reactive backstop that sits under the proactive ledger/budget signals.
    const reactiveUnavailable = new Map<string, number>(); // candidate key -> unavailable-until epoch ms
    const reactiveWindowMs = config.failover.circuit_breaker_cooldown_seconds * 1000;
    const candidateKey = (c: ConcreteCandidate): string => (c.provider === 'claude' ? `claude:${c.account ?? ''}` : c.provider);
    const isReactivelyUnavailable = (key: string, nowMs: number): boolean => {
      const until = reactiveUnavailable.get(key);
      if (until === undefined) return false;
      if (nowMs >= until) { reactiveUnavailable.delete(key); return false; }
      return true;
    };
    const markCandidateUnavailable = (c: ConcreteCandidate, nowMs: number): void => {
      reactiveUnavailable.set(candidateKey(c), nowMs + reactiveWindowMs);
    };

    const claudeUsage = new ClaudeProviderUsage({
      ledger: usageLedger,
      getAccount: (name) => {
        const a = accountRegistry.get(name);
        if (!a) return null;
        const nowMs = Date.now();
        const inCooldown = a.state === 'UNAVAILABLE' || a.state === 'COOLDOWN' || (a.cooldownUntil !== null && a.cooldownUntil.getTime() > nowMs);
        return { name: a.name, enabled: a.enabled, inCooldown, reactivelyUnavailable: isReactivelyUnavailable(`claude:${a.name}`, nowMs) };
      },
    });

    const codexBudget = resolveCodexBudget(config.roles);
    const codexBudgetUsage = new CodexProviderUsage({ ledger: usageLedger, budget: codexBudget });
    // Wrap the budget meter with the reactive backstop so a 429/quota error stops codex until reset.
    const codexUsage: ProviderUsage = {
      usageSignal: (cand, nowMs) =>
        isReactivelyUnavailable(candidateKey(cand), nowMs)
          ? { available: false, headroom_pct: null, remaining_tokens: null, basis: 'budget', reason: 'reactive_unavailable' }
          : codexBudgetUsage.usageSignal(cand, nowMs),
    };

    const providerAccounts = (): { name: string; enabled: boolean }[] => accountRegistry.getAll().map((a) => ({ name: a.name, enabled: a.enabled }));
    const selectCandidates = (role: WorkerRole, _task: WorkerTask, nowMs: number): ConcreteCandidate[] =>
      resolveCandidates(config.roles[role], { claudeUsage, codexUsage, accounts: providerAccounts() }, nowMs);
    // A pinned `claude` resolves to its best available account via the same scorer/selector (single candidate).
    const resolvePinnedClaude = (nowMs: number): ConcreteCandidate | null =>
      resolveCandidates([{ provider: 'claude', model: null, effort: null, budget: null }], { claudeUsage, codexUsage, accounts: providerAccounts() }, nowMs)[0] ?? null;

    workerOrchestrator = new WorkerOrchestrator({
      store: workerStore,
      config: config.workers,
      journal,
      worktreeOps: {
        resolveBaseSha,
        createWorktree,
        captureDiff,
        snapshotMainTree,
        auditBoundary,
        sanitizePatch,
        patchSha256,
        removeWorktree,
        isGitRepo,
        applyCheck,
        applyReverseCheck,
      },
      validateOutput: validateWorkerOutput,
      reviewOutput: reviewWorkerOutput,
      mergeOutput: mergeWorkerOutput,
      resolveActiveSessionCwd: () => sessionManager.getActiveSession()?.cwd ?? null,
      selectCandidates,
      recordCodexUsage: (provider, tokens, nowMs) => usageLedger.recordConsumption(provider, tokens, nowMs, codexBudget),
      markCandidateUnavailable,
      getClaudeAccountConfigDir: (account) => accountRegistry.get(account)?.configDir ?? null,
      resolvePinnedClaude,
      // Cross-LLM failover → notify the active session's Slack channel (account↔account is routine, not posted).
      notifyCrossProviderFailover: (taskId, from, to) => {
        const active = sessionManager.getActiveSession();
        void slackService?.notifyWorkerFailover({ sessionId: active?.aisup_session_id ?? null, taskId, from, to });
      },
      // A worker reaching awaiting_approval → post an interactive worker card to Slack (A7).
      notifyAwaitingApproval: (id) => {
        const active = sessionManager.getActiveSession();
        void slackService?.notifyWorkerAwaitingApproval(active?.aisup_session_id ?? null, id);
        void emitNtfy({ title: 'Worker awaiting approval', message: `Worker ${id} is ready for review.`, tags: ['eyes'] });
      },
    });

    // Per-provider usage readout for `aisup worker providers` / GET /api/workers/providers.
    getWorkerProviders = () =>
      buildProviderUsageReport(
        config.roles,
        { claudeUsage, codexUsage, accounts: accountRegistry.getAll().map((a) => ({ name: a.name, enabled: a.enabled })) },
        Date.now()
      );
  }

  // Validation gates: run the configured executable/arg-array gates (manual via API/Slack/CLI,
  // automatic via the idle+skill trigger). The latest run is cached for GET /api/gates.
  let latestGateRun: GateRunResult | null = null;
  const runConfiguredGates = async (): Promise<GateRunResult> => {
    // Centralized guard for ALL gate entry points (HTTP /api/gates/run, Slack !gate, idle trigger):
    // a gate-execution failure must return a failed result, never throw/crash the handler (AF-301).
    try {
      const active = sessionManager.getActiveSession();
      const result = await runGates(config.gates.gates, { journal, defaultCwd: active?.cwd });
      latestGateRun = result;
      return result;
    } catch (err: unknown) {
      try {
        process.stderr.write(`[aisup daemon] gate run failed: ${err instanceof Error ? err.message : String(err)}\n`);
      } catch { /* log sink down */ }
      const result: GateRunResult = { passed: false, results: [] };
      latestGateRun = result;
      return result;
    }
  };

  // Permission broker via Claude Code's PermissionRequest hook (F). The hook is the reliable
  // *detector* (structured tool name + input); it does NOT block. It posts to Slack and lets the
  // terminal dialog appear. `!permit`/`!deny` then resolves by sending a keystroke to that dialog —
  // which never times out — so a human can decide minutes or hours later. Pending requests keyed by
  // aisup session id (the dialog persists; the keystroke confirms whichever option the config names).
  // Per-session FIFO queue of pending hook permissions (AF-302): two concurrent permission.ask for
  // one session are both tracked and resolved independently (earliest-first), not overwritten.
  // Persisted (A3) so a pending permission survives a daemon restart and its original card re-binds.
  const hookPermissions = new PendingPermissionQueue(join(AISUP_DIR, 'pending-permissions.json'));
  // Shared freshness re-scan: is a permission prompt still showing in the session's pane? Used as the
  // A2 guard on BOTH the hook keystroke path and the legacy broker fallback so a button tap never
  // injects a keystroke into a closed/different prompt. When detection is disabled there is nothing
  // to re-scan, so resolution proceeds (preserves the pre-A2 hook behavior).
  const promptStillActive = (aisupSessionId: string): boolean => {
    if (!config.permissions.enabled) return true;
    const s = sessionManager.readState(aisupSessionId);
    if (!s) return false;
    const recent = captureOutput(tmuxSocket, s.tmux_name, 40);
    return new PermissionDetector(config.permissions.detection_patterns).scan(recent).length > 0;
  };
  // The hook keystroke resolver (extracted to src/permissions/hook-resolver.ts so the host-gated
  // never-timeout test and the unit suite drive the exact production path A2/A3 build on).
  const hookResolverDeps: HookResolverDeps = {
    queue: hookPermissions,
    readState: (id) => sessionManager.readState(id),
    sendKeystroke: (tmuxName, key) => {
      sendText(tmuxSocket, tmuxName, key);
      sendEnter(tmuxSocket, tmuxName);
    },
    promptStillActive,
    permissions: config.permissions,
    journal,
  };

  let slackService: SlackService | null = null;
  if (config.slack.enabled) {
    const channelMapPath = join(AISUP_DIR, 'channel-map.json');
    slackService = new SlackService({
      config: config.slack,
      sessionManager,
      tmuxSocket,
      journal,
      journalPath: config.journal.path,
      channelMapPath,
      cardStorePath: join(AISUP_DIR, 'slack-cards.json'),
      permissionsConfig: config.permissions,
      notificationsConfig: config.notifications,
      // Resolve a hook-routed permission via a keystroke to the persistent dialog; fall back to the
      // legacy scrape broker if this session has no hook-pending permission.
      onPermissionGrant: (sessionId, requestId) =>
        resolveHookPermissionViaKeystroke(hookResolverDeps, sessionId, true, requestId) ? Promise.resolve(true) : (permissionBrokerRef?.resolveFromSlack(sessionId, 'grant') ?? Promise.resolve(false)),
      onPermissionDeny: (sessionId, requestId) =>
        resolveHookPermissionViaKeystroke(hookResolverDeps, sessionId, false, requestId) ? Promise.resolve(true) : (permissionBrokerRef?.resolveFromSlack(sessionId, 'deny') ?? Promise.resolve(false)),
      onGateRun: runConfiguredGates,
      getLatestGateRun: () => latestGateRun,
      onWorkerApprove: workerOrchestrator ? (id) => workerOrchestrator!.approve(id, 'slack') : undefined,
      onWorkerDeny: workerOrchestrator ? (id) => workerOrchestrator!.deny(id, 'slack') : undefined,
      onWorkerRetry: workerOrchestrator ? (id) => workerOrchestrator!.retry(id) : undefined,
      getWorkerStatus: workerOrchestrator ? () => workerOrchestrator!.list() : undefined,
      getWorkerDiff: workerOrchestrator
        ? (id) => {
            const w = workerOrchestrator!.get(id);
            return w?.output ? { title: w.task.title, patch: w.output.patch } : null;
          }
        : undefined,
      // A6 observability readers — reuse the same aggregations the HTTP API / CLI use (numbers match).
      getAccountsView: () => {
        refreshAccounts();
        return buildAccountsView({
          accountRegistry,
          usageLedger,
          statuslineDir: config.statusline.directory,
          freshnessWindowS: config.statusline.freshness_window_s,
          nowMs: Date.now(),
        });
      },
      getCostView: () => aggregateCosts({ journalPath: config.journal.path }),
      onAccountOverride: async (action, name) => {
        if (action === 'clear') { accountRegistry.clearOverrides(); refreshAccounts(); return { ok: true }; }
        if (!name || !accountRegistry.get(name)) return { ok: false, error: `unknown account "${name ?? ''}"` };
        const map = { pin: { pinned: true }, exclude: { excluded: true }, enable: { enabled: true }, disable: { enabled: false } } as const;
        accountRegistry.setOverride(name, map[action]);
        refreshAccounts();
        return { ok: true };
      },
      onSessionPause: async () => {
        const active = sessionManager.getActiveSession();
        if (!active) return { ok: false, reason: 'no active session' };
        const res = await sessionManager.pauseSession(active.aisup_session_id);
        if (res.ok) { const s = sessionManager.readState(active.aisup_session_id); if (s) server.setSessionState(s); }
        return res;
      },
      onSessionResume: async () => {
        const paused = sessionManager.getPausedSession();
        if (!paused) return { ok: false, reason: 'no paused session' };
        const res = await sessionManager.resumeSession(paused.aisup_session_id);
        if (res.ok) { const s = sessionManager.readState(paused.aisup_session_id); if (s) server.setSessionState(s); }
        return res;
      },
      getWorkerProvidersView: getWorkerProviders ? () => getWorkerProviders!() : undefined,
      getHealthView: () => {
        const active = sessionManager.getActiveSession();
        const accts = accountRegistry.getAll();
        const workers = workerOrchestrator?.list() ?? null;
        return {
          session: active
            ? { id: active.aisup_session_id, status: active.status, account: active.account }
            : { id: null, status: null, account: null },
          daemonOk: true,
          workers: workers
            ? {
                queued: workers.filter((w) => w.status === 'QUEUED').length,
                running: workers.filter((w) => w.status === 'RUNNING').length,
                awaiting_approval: workers.filter((w) => w.status === 'AWAITING_APPROVAL').length,
              }
            : null,
          accounts: { total: accts.length, healthy: accts.filter((a) => a.state === 'HEALTHY').length },
        };
      },
    });
  }

  // PermissionRequest hook handler (F): evaluate policy, then auto-decide or block on a Slack decision.
  // PermissionRequest hook (F) — NON-BLOCKING detector. Returns 'deny' to hard-deny (denylist / no
  // session), 'allow' for an allowlisted tool, or null to DEFER to Claude's terminal dialog (which
  // never times out). The 'ask' path posts to Slack and registers a pending request; `!permit`/
  // `!deny` later confirms the dialog with a keystroke. We never block the hook on a human, so
  // Claude Code's hook-timeout cap is irrelevant and a decision can come minutes or hours later.
  const onPermissionHook = async (req: PermissionHookRequest): Promise<'allow' | 'deny' | null> => {
    const active = sessionManager.getActiveSession();
    if (!active) return 'deny'; // no session to attribute → safe default (hook-deny works)
    const detail = summarizeToolInput(req.toolInput);
    // Opaque id every card/queue entry is keyed by — generated at hook time so out-of-order button
    // taps resolve the correct request (id-routing, A2), threaded through the queue and the card value.
    const request: PermissionRequest = {
      tool: req.toolName,
      detail,
      raw: `${req.toolName}: ${detail}`.slice(0, 200),
      request_id: randomUUID(),
    };

    const decision = evaluatePermission(request, config.permissions.policy);
    if (decision === 'grant' || decision === 'deny') {
      void journal.append({
        ts: new Date().toISOString(),
        event_type: decision === 'grant' ? 'permission.auto_granted' : 'permission.auto_denied',
        aisup_session_id: active.aisup_session_id,
        details: { tool: request.tool, detail, source: 'hook' },
      });
      return decision === 'grant' ? 'allow' : 'deny';
    }

    // 'ask' but no Slack to ask → fall back to the policy default (no human available).
    if (!config.permissions.slack_routing || !slackService) {
      return config.permissions.policy.default_action === 'allow' ? 'allow' : 'deny';
    }
    // Register the pending request (appended to the session's FIFO queue), post to Slack, and DEFER
    // (null) so the dialog shows and waits. Concurrent asks queue rather than overwrite (AF-302).
    hookPermissions.enqueue(active.aisup_session_id, request);
    void journal.append({
      ts: new Date().toISOString(),
      event_type: 'permission.detected',
      aisup_session_id: active.aisup_session_id,
      details: { tool: request.tool, detail, source: 'hook' },
    });
    void slackService.notifyPermissionRequest(active.aisup_session_id, request);
    void journal.append({
      ts: new Date().toISOString(),
      event_type: 'permission.routed_to_slack',
      aisup_session_id: active.aisup_session_id,
      details: { tool: request.tool, detail },
    });
    return null;
  };

  const server = await createDaemonServer({
    tokenPath: TOKEN_PATH,
    host: '127.0.0.1',
    port: config.daemon.port,
    sessionManager,
    accountRegistry,
    journal,
    journalPath: config.journal.path,
    runner: config.runner,
    createSessionForTarget: (target, snapshot, launchMode) => createSessionForTargetRef!(target, snapshot, launchMode),
    onSkillHook: (commandName, claudeSessionId) => {
      const skill = resolveSkillFromCommandName(commandName, config.skills.tracked);
      if (!skill) return;
      const active = sessionManager.getActiveSession();
      if (!active) return;
      // Attribute only to the matching live session (csid may not be bound yet → accept).
      if (claudeSessionId && active.claude_session_id && active.claude_session_id !== claudeSessionId) return;
      if (active.active_skill === skill) return;
      sessionManager.patchState(active.aisup_session_id, { active_skill: skill });
      void journal.append({
        ts: new Date().toISOString(),
        event_type: 'skill.detected',
        aisup_session_id: active.aisup_session_id,
        details: { skill, previous_skill: active.active_skill ?? null, source: 'hook' },
      });
    },
    onPermissionHook,
    onActivityHook: (req) => {
      if (!slackService) return;
      const active = sessionManager.getActiveSession();
      if (!active) return;
      if (req.claudeSessionId && active.claude_session_id && active.claude_session_id !== req.claudeSessionId) return;
      void slackService.postActivity(active.aisup_session_id, {
        toolName: req.toolName,
        toolInput: req.toolInput,
        toolResponse: req.toolResponse,
      });
    },
    runGates: runConfiguredGates,
    getLatestGateRun: () => latestGateRun,
    dispatchWorker: workerOrchestrator ? (input) => workerOrchestrator!.dispatch(input) : undefined,
    listWorkers: workerOrchestrator ? () => workerOrchestrator!.list() : undefined,
    getWorker: workerOrchestrator ? (id) => workerOrchestrator!.get(id) : undefined,
    approveWorker: workerOrchestrator ? (id, by) => workerOrchestrator!.approve(id, by) : undefined,
    denyWorker: workerOrchestrator ? (id, by) => workerOrchestrator!.deny(id, by) : undefined,
    cancelWorker: workerOrchestrator ? (id) => workerOrchestrator!.cancel(id) : undefined,
    retryWorker: workerOrchestrator ? (id) => workerOrchestrator!.retry(id) : undefined,
    undoWorker: workerOrchestrator ? (id) => workerOrchestrator!.undoMerge(id) : undefined,
    cleanupWorktrees: workerOrchestrator ? (force) => workerOrchestrator!.cleanupWorktrees(force) : undefined,
    getWorkerProviders,
    getLoopHealth: () => loopManagerRef?.getLoopHealth() ?? [],
    onSessionStart: (session) => {
      void emitNtfy({ title: 'Session started', message: `aisup session ${session.name ?? session.aisup_session_id} on ${session.account}.`, tags: ['rocket'] });
      return slackService?.onSessionStart(session);
    },
    onSessionStop: (session) => {
      // R13: a stopped session ends the recovery cycle — clear its restart + network windows.
      loopManagerRef?.clearRecoveryCounters(session.aisup_session_id);
      // A terminal stop also ends any EXHAUSTED auto-resume polling for the session.
      exhaustedRecoveryRef?.stop(session.aisup_session_id);
      // Drop any pending hook permissions for the stopped session (its dialog/pane is gone).
      hookPermissions.clear(session.aisup_session_id);
      return slackService?.onSessionStop(session.aisup_session_id);
    },
    refreshAccounts,
    statuslineDir: config.statusline.directory,
    statuslineFreshnessWindowS: config.statusline.freshness_window_s,
    usageLedger,
    // Lifecycle cost snapshots: stop/manual-failover live in server.ts, so the snapshot/cleanup
    // are injected from the loop manager (late-bound; no-op until it exists).
    captureCostSnapshot: (id, trigger) => loopManagerRef?.captureFinalCostSnapshot(id, trigger),
    clearCostTracking: (id) => loopManagerRef?.clearCostTracking(id),
  });

  await server.listen({ host: '127.0.0.1', port: config.daemon.port });

  await writePidFile(PID_PATH, { pid: process.pid, port: config.daemon.port });

  await journal.append({
    ts: new Date().toISOString(),
    event_type: 'daemon.started',
    details: { pid: process.pid, port: config.daemon.port },
  });

  // Late-bound LoopManager handle: onSwitch/onSessionStop are defined before the loop
  // manager exists (rehydration uses them), so they clear the recovery counters via
  // this ref (no-op during rehydration, before the manager is constructed).
  let loopManagerRef: LoopManager | undefined;
  let exhaustedRecoveryRef: ExhaustedRecovery | undefined;
  let permissionBrokerRef: PermissionBroker | undefined;
  // Assigned after createSessionForTarget is defined; lets the server's /api/failover reuse the
  // daemon's canonical launcher (continuation injection) instead of a divergent inline copy.
  let createSessionForTargetRef:
    | ((target: AccountInfo, snapshot: SwitchSnapshot, launchMode: LaunchMode) => Promise<SessionState>)
    | undefined;

  // Shared target-launch callback: resume only when migration produced a valid transcript
  // in the target, else fresh. Used by both automatic failover and EXHAUSTED auto-resume.
  const createSessionForTarget = async (
    acct: AccountInfo,
    snapshot: SwitchSnapshot,
    launchMode: LaunchMode,
  ): Promise<SessionState> => {
    const cmd = (launchMode === 'resumed' && snapshot.claudeSessionId)
      ? buildResumeCommand(config.runner, acct.configDir, snapshot.claudeSessionId)
      : buildLaunchCommand(config.runner, acct.configDir);
    if (!snapshot.claudeSessionId) {
      await journal.append({
        ts: new Date().toISOString(),
        event_type: 'recovery.restart_fresh_no_session_id',
        aisup_session_id: snapshot.aisupSessionId,
        details: { account: acct.name, reason: snapshot.reason },
      });
    }
    const cwd = sessionManager.readState(snapshot.aisupSessionId)?.cwd ?? process.cwd();
    const state = await sessionManager.createSession({
      aisupSessionId: snapshot.aisupSessionId,
      account: acct.name,
      command: cmd.command,
      args: cmd.args,
      env: cmd.env,
      cwd,
      planPath: snapshot.planFilePath,
    });

    // Continuation prompt (J): nudge the resumed session to pick its skill/plan back up. Gated by
    // resume_prompt_mode — 'always' = every switch, 'on-failure' = non-manual (failure-driven) only,
    // 'never' = skip (default, zero added tokens). Best-effort, delayed so the resumed TUI is ready;
    // never blocks the switch. --resume already restores full context; this is the explicit nudge.
    const mode = config.session.resume_prompt_mode;
    const wantContinuation =
      // Only when an actual transcript was restored — a fresh launch has nothing to "continue".
      launchMode === 'resumed' &&
      (mode === 'always' || (mode === 'on-failure' && snapshot.reason !== SwitchReason.Manual));
    if (wantContinuation && (snapshot.activeSkill || snapshot.planFilePath)) {
      const prompt = buildContinuationPrompt({ activeSkill: snapshot.activeSkill, planPath: snapshot.planFilePath });
      setTimeout(() => {
        try {
          sendText(tmuxSocket, state.tmux_name, prompt);
          sendEnter(tmuxSocket, state.tmux_name);
          void journal.append({
            ts: new Date().toISOString(),
            event_type: 'continuation.injected',
            aisup_session_id: snapshot.aisupSessionId,
            details: { account: acct.name, skill: snapshot.activeSkill ?? null, plan_path: snapshot.planFilePath ?? null },
          });
        } catch { /* best-effort; transcript resume already carries context */ }
      }, 4000);
    }
    return state;
  };

  // Expose the canonical launcher to the server's /api/failover (manual failover now injects the
  // continuation prompt identically to automatic failover — no divergent inline launch logic).
  createSessionForTargetRef = createSessionForTarget;

  // Daemon-level recovery callbacks. Defined before rehydration so the rehydration pass
  // can drive corrective recovery for interrupted switches and state-without-tmux sessions,
  // and reused as the LoopManager's onSwitch/onRestart. onSwitch reads readState(sessionId)
  // (not getActiveSession) so it can also act on mid-switch SWITCHING sessions.
  const onSwitch = async (sessionId: string, reason: SwitchReason): Promise<void> => {
    const state = sessionManager.readState(sessionId);
    if (!state) return;
    // R13: a switch ends the recovery cycle — clear its restart + network windows.
    loopManagerRef?.clearRecoveryCounters(sessionId);
    // Task 3: capture the pre-switch final cost snapshot before performSwitch destroys the source.
    loopManagerRef?.captureFinalCostSnapshot(sessionId, 'pre_switch');
    refreshAccounts();
    const accounts = accountRegistry.getAll();
    const { performSwitch, explainSelection, handleNoTarget } = await import('../failover/switcher.js');
    // Pass reason + the source's refreshed score so the actual switch honours the same
    // soft-threshold "strictly better target" rule the loop-manager precheck applied.
    const currentScore = accountRegistry.get(state.account)?.score ?? null;
    // explainSelection returns the same winner as selectSwitchTarget plus the per-candidate
    // rationale (C2), so both the exhausted notification and the account.switch event can say WHY.
    const { chosen: target, rationale } = explainSelection(accounts, state.account, [], { reason, currentScore });
    if (!target) {
      // Soft-threshold no-better-target is nonterminal; every other reason persists EXHAUSTED.
      const { terminal } = await handleNoTarget(
        { sessionId, fromAccount: state.account, reason, triedAccounts: [], sourceRunnerAlive: true },
        {
          sessionManager,
          journal,
          setSessionVisible: (s) => server.setSessionState(s),
          notifyExhausted: (id) => {
            void emitNtfy({ title: 'Session EXHAUSTED', message: `Session ${id} has no eligible failover account (reason: ${reason}).`, priority: 'high', tags: ['warning'] });
            return slackService?.onSessionExhausted(id, String(reason), rationale);
          },
        }
      );
      if (terminal) exhaustedRecoveryRef?.start(sessionId);
      return;
    }
    const result = await performSwitch(
      {
        aisupSessionId: sessionId,
        claudeSessionId: state.claude_session_id,
        transcriptPath: state.transcript_path,
        activeSkill: state.active_skill,
        planFilePath: state.plan_path,
        sourceAccount: state.account,
        targetAccount: target.name,
        reason,
        selectionMode: reason === SwitchReason.Manual ? 'manual' : 'automatic',
        rationale,
      },
      accounts,
      { sessionManager, journal, createSessionForTarget }
    );
    if (result.status === 'exhausted') {
      server.setSessionState({ status: 'EXHAUSTED', aisup_session_id: sessionId, hasTmux: false });
      exhaustedRecoveryRef?.start(sessionId);
    } else if (result.status === 'completed' && result.targetAccount) {
      circuitBreaker.recordSuccess(result.targetAccount);
      accountRegistry.setState(result.targetAccount, 'HEALTHY', null);
    }
  };

  const onRestart = async (sessionId: string): Promise<boolean> => {
    const state = sessionManager.readState(sessionId);
    if (!state) return false;
    const account = accountRegistry.get(state.account);
    if (!account) return false;
    const cmd = state.claude_session_id
      ? buildResumeCommand(config.runner, account.configDir, state.claude_session_id)
      : buildLaunchCommand(config.runner, account.configDir);
    if (!state.claude_session_id) {
      await journal.append({
        ts: new Date().toISOString(),
        event_type: 'recovery.restart_fresh_no_session_id',
        aisup_session_id: sessionId,
        details: { account: state.account },
      });
    }
    try {
      await sessionManager.restartInPlace(sessionId, cmd.command, cmd.args, cmd.env);
      return true;
    } catch (err) {
      await journal.append({
        ts: new Date().toISOString(),
        event_type: 'recovery.failed',
        aisup_session_id: sessionId,
        details: { error: String(err), action: 'same_account_restart_failed' },
      });
      return false;
    }
  };

  // EXHAUSTED auto-recovery: poll for a runnable account, then relaunch the persisted
  // session via the canonical performSwitch path (migration owns resume vs fresh). The
  // resume is never a bare state flip — onAccountAvailable reads the persisted source account.
  const exhaustedRecovery = new ExhaustedRecovery({
    circuitBreaker,
    accountRegistry,
    config: config.recovery,
    journal,
    // Refresh registry state from telemetry before the poller picks a resume target.
    refreshAccounts,
    onAccountAvailable: async (sessionId, account) => {
      // If the session already left EXHAUSTED (manual failover/stop/another resume), end polling.
      const current = sessionManager.readState(sessionId);
      if (!current || current.status !== 'EXHAUSTED') {
        exhaustedRecoveryRef?.stop(sessionId);
        return;
      }
      refreshAccounts();
      const { performSwitch } = await import('../failover/switcher.js');
      const ok = await resumeExhaustedSession(sessionId, account, {
        sessionManager,
        accounts: accountRegistry.getAll(),
        journal,
        performSwitch,
        switchDeps: { sessionManager, journal, createSessionForTarget },
        onResumed: (target) => {
          circuitBreaker.recordSuccess(target);
          accountRegistry.setState(target, 'HEALTHY', null);
        },
      });
      // Success ends polling; a failed relaunch leaves the session EXHAUSTED for the next tick.
      if (ok) exhaustedRecoveryRef?.stop(sessionId);
    },
  });
  exhaustedRecoveryRef = exhaustedRecovery;

  const liveSessions = new Set(sessionManager.listTmuxSessions());

  const { exhaustedSessionIds } = await rehydrateSessions({
    stateDir: join(AISUP_DIR, 'sessions'),
    tmuxSocket,
    liveSessions,
    setSessionState: (session) => server.setSessionState(session),
    journal,
    onSwitch,
    onRestart,
    statuslineDir: config.statusline.directory,
    statuslineFreshnessWindowS: config.statusline.freshness_window_s,
    accountConfigDir: (account) => accountRegistry.get(account)?.configDir,
    reconcilePermissionCards: slackService
      ? (isSessionLive) => slackService!.reconcilePendingPermissions(isSessionLive)
      : undefined,
  });

  // R8/Task 7 handoff: re-arm the exhausted poller for sessions rehydrated as EXHAUSTED.
  // start() is a no-op when auto_resume_exhausted is disabled.
  for (const sessionId of exhaustedSessionIds) exhaustedRecovery.start(sessionId);

  // Worker rehydration: reconcile interrupted workers (in-flight → FAILED, MERGING reconciled
  // against the patch) and pump any QUEUED workers (Phase 3, HI-003).
  if (workerOrchestrator) await workerOrchestrator.start();

  // Register tmux timeout handler — emits tmux.command_timeout journal events
  setTmuxTimeoutHandler((event) => {
    void journal.append({
      ts: new Date().toISOString(),
      event_type: 'tmux.command_timeout',
      details: { operation: event.operation, target: event.target, timeout_ms: event.timeoutMs },
    });
  });

  // Permission detection runs only when enabled; the empty config list falls back to the
  // detector's built-in default patterns. The broker (policy + Slack) is wired in onPermissionDetected.
  const permissionDetector = config.permissions.enabled
    ? new PermissionDetector(config.permissions.detection_patterns)
    : undefined;

  // Broker side effects (tmux keystrokes, Slack routing) live here, not in the pure policy.
  const permissionBroker = config.permissions.enabled
    ? new PermissionBroker({
        permissions: config.permissions,
        journal,
        sendKeystroke: (sessionId, key) => {
          const s = sessionManager.readState(sessionId);
          if (!s || (s.status !== 'ACTIVE' && s.status !== 'SWITCH_PENDING_AT_IDLE')) return false;
          sendText(tmuxSocket, s.tmux_name, key);
          sendEnter(tmuxSocket, s.tmux_name);
          return true;
        },
        promptStillActive,
        routeToSlack: config.slack.enabled
          ? (sessionId, request) => {
              void slackService?.notifyPermissionRequest(sessionId, request);
              void emitNtfy({ title: 'Permission requested', message: 'Claude is asking for tool permission — approve in Slack.', priority: 'high', tags: ['lock'] });
            }
          : undefined,
      })
    : undefined;
  permissionBrokerRef = permissionBroker;

  // A8: collapse the per-tick threshold stream into one Slack alert per upward band crossing, with an
  // optional early `warning` band. Emission of `rate_limit.threshold_crossed` is unchanged below.
  const thresholdAlerter = new ThresholdAlerter({
    warningPct: config.thresholds.warning_pct,
    notify: (alert) => {
      const active = sessionManager.getActiveSession();
      void slackService?.notifyThreshold(active?.aisup_session_id ?? null, alert);
      void emitNtfy({ title: 'Usage threshold crossed', message: `${alert.account}: ${alert.band} threshold crossed.`, tags: ['chart_with_upwards_trend'] });
    },
  });

  const loopManager = new LoopManager({
    rateLimitIntervalMs: config.monitoring.rate_limit_interval_s * 1000,
    healthIntervalMs: config.monitoring.health_interval_s * 1000,
    recoveryIntervalMs: config.monitoring.recovery_interval_s * 1000,
    idleIntervalMs: config.monitoring.idle_interval_s * 1000,
    onThresholdBreach: (result) => {
      if (result.level !== 'none') {
        void journal.append({
          ts: new Date().toISOString(),
          event_type: 'rate_limit.threshold_crossed',
          details: {
            level: result.level,
            triggered_window: result.triggeredWindow,
            five_hour_pct: result.fiveHourPct ?? null,
            seven_day_pct: result.sevenDayPct ?? null,
            soft_pct: config.thresholds.soft_pct,
            hard_pct: config.thresholds.hard_pct,
            reset_eta: result.resetsAt?.toISOString() ?? null,
          },
        });
      }
      // A8: de-duped Slack delivery (incl. the optional warning band). Emission above is unchanged.
      const account = sessionManager.getActiveSession()?.account;
      if (account) {
        thresholdAlerter.onResult({
          account,
          level: result.level,
          fiveHourPct: result.fiveHourPct ?? null,
          sevenDayPct: result.sevenDayPct ?? null,
          resetEta: result.resetsAt?.toISOString() ?? null,
        });
      }
    },
    onCrashDetected: (sessionId, has429) => {
      void journal.append({
        ts: new Date().toISOString(),
        event_type: 'failure.detected',
        aisup_session_id: sessionId,
        details: { has429, source: 'recovery_handler' },
      });
    },
    onHealthResult: (result) => {
      if (!result.configDirExists || !result.configDirWritable) {
        void journal.append({
          ts: new Date().toISOString(),
          event_type: 'failure.detected',
          details: { account: result.account, configDirExists: result.configDirExists, configDirWritable: result.configDirWritable },
        });
      }
    },
    onIdle: (sessionId) => {
      // Idle is observation, not a lifecycle stop. session.stop is reserved for terminal
      // user/API/Slack stop paths; idle emits the canonical non-lifecycle idle event.
      void journal.append({
        ts: new Date().toISOString(),
        event_type: 'session.idle_detected',
        aisup_session_id: sessionId,
        details: { reason: 'idle_timeout' },
      });
    },
    deps: {
      sessionManager,
      accountRegistry,
      softPct: config.thresholds.soft_pct,
      hardPct: config.thresholds.hard_pct,
      idleBoundarySeconds: config.thresholds.idle_boundary_seconds,
      statuslineDir: config.statusline.directory,
      statuslineFreshnessWindowS: config.statusline.freshness_window_s,
      usageLedger,
      tmuxSocket,
      networkErrorThreshold: config.recovery.network_error_threshold,
      journal,
      trackedSkills: config.skills.tracked,
      onOutputLogRotated: (sessionId, path) => {
        slackService?.resetRelayCursor(sessionId, path);
      },
      circuitBreaker,
      permissionDetector,
      onPermissionDetected: permissionBroker
        ? (sessionId, request) => { void permissionBroker.onDetected(sessionId, request); }
        : undefined,
      onGateTrigger: (config.gates.enabled && config.gates.trigger === 'idle_and_skill')
        ? async () => { await runConfiguredGates(); }
        : undefined,
      gateDebounceMs: config.gates.idle_delay_seconds * 1000,
      onSwitch,
      onRestart,
    },
  });

  // Init recovery handler cursor for any rehydrated session
  const activeSession = sessionManager.getActiveSession();
  if (activeSession) {
    const fileSize = RecoveryHandler.getFileSize(activeSession.output_log_path);
    // Live pane: start at EOF. Dead/missing pane: start at max(0, size - 64KB)
    const cursorOffset = liveSessions.has(activeSession.tmux_name)
      ? fileSize
      : Math.max(0, fileSize - 65536);
    loopManager.recoveryHandler.initCursor(
      activeSession.aisup_session_id,
      activeSession.output_log_path,
      cursorOffset
    );
  }

  loopManagerRef = loopManager;
  loopManager.startAll();

  server.setReady();

  await journal.append({
    ts: new Date().toISOString(),
    event_type: 'daemon.ready',
    details: {},
  });

  if (slackService) {
    void slackService.start().catch((err) => {
      void journal.append({
        ts: new Date().toISOString(),
        event_type: 'slack.connection_error',
        details: { error: String(err) },
      });
      slackService = null;
    });
  }

  const shutdown = async (signal: string): Promise<void> => {
    loopManager.stopAll();
    exhaustedRecovery.stopAll();
    if (slackService) { try { await slackService.stop(); } catch { /* best effort */ } }
    await journal.append({
      ts: new Date().toISOString(),
      event_type: 'daemon.stopped',
      details: { signal },
    });
    await server.close();
    await removePidFile(PID_PATH);
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // C13: SIGHUP hot-reloads config — re-read the file and apply the safe (non-structural) subset
  // to the live loops/registry/Slack WITHOUT dropping the supervised session.
  let reloadBaseline = config;
  process.on('SIGHUP', () => void (async () => {
    try {
      resetConfigCache();
      const next = await loadConfig();
      const plan = planReload(reloadBaseline, next);
      // Apply the hot subset.
      loopManager.updateThresholds(next.thresholds.soft_pct, next.thresholds.hard_pct);
      slackService?.setDefaultVerbosity(next.notifications.verbosity);
      slackService?.setAllowedUsers(next.slack.allowed_user_ids);
      accountRegistry.syncConfigEnabled(next.accounts.map((a) => ({ name: a.name, enabled: a.enabled })));
      reloadBaseline = next;
      await journal.append({
        ts: new Date().toISOString(),
        event_type: 'daemon.reloaded',
        details: { applied: plan.applied, restart_required: plan.restart_required },
      });
      process.stdout.write(`[aisup daemon] reloaded — applied: [${plan.applied.join(', ')}] restart-required: [${plan.restart_required.join(', ')}]\n`);
    } catch (err) {
      process.stderr.write(`[aisup daemon] reload failed: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  })());

  // AF-301 backstop: the supervisor daemon's one job is to keep the supervised session alive. A stray
  // rejection or uncaught error (gate/journal/Slack hiccup, etc.) must NOT take it down. Log loudly +
  // best-effort journal, but DO NOT process.exit — overriding Node's default crash-on-unhandled.
  const handleDaemonError = (kind: string) => (err: unknown): void => {
    const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
    try {
      process.stderr.write(`[aisup daemon] ${kind} (non-fatal — daemon staying up): ${detail}\n`);
    } catch { /* log sink down */ }
    void journal.append({
      ts: new Date().toISOString(),
      event_type: 'daemon.uncaught_error',
      details: { kind, error: err instanceof Error ? err.message : String(err) },
    });
  };
  process.on('unhandledRejection', handleDaemonError('unhandledRejection'));
  process.on('uncaughtException', handleDaemonError('uncaughtException'));
}

main().catch((err: unknown) => {
  process.stderr.write(`[aisup daemon] fatal: ${String(err)}\n`);
  process.exit(1);
});
