import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDaemonServer } from '../../src/daemon/server.js';
import { AccountRegistry } from '../../src/accounts/registry.js';
import type { AisupConfig } from '../../src/config/schema.js';
import type { FastifyInstance } from 'fastify';

describe('daemon HTTP server', () => {
  let tmpDir: string;
  let tokenPath: string;
  let token: string;
  let app: FastifyInstance;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'aisup-server-'));
    mkdirSync(join(tmpDir, '.aisup'), { mode: 0o700 });
    token = 'test-bearer-token-12345';
    tokenPath = join(tmpDir, '.aisup', 'api-token');
    writeFileSync(tokenPath, token, { mode: 0o600 });

    app = await createDaemonServer({ tokenPath, host: '127.0.0.1', port: 0 });
  });

  afterEach(async () => {
    await app.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should return health check without auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ ready: boolean; pid: number }>();
    expect(body.ready).toBe(false); // not ready until setReady() called
    expect(body.pid).toBe(process.pid);
  });

  it('should return 503 on non-health routes before daemon is ready', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: '/tmp' }),
    });
    expect(res.statusCode).toBe(503);
    const body = res.json<{ error: string }>();
    expect(body.error).toBe('daemon_starting');
  });

  it('should reject requests without bearer token', async () => {
    // mark ready so auth is checked
    app.setReady();
    const res = await app.inject({ method: 'GET', url: '/api/status' });
    expect(res.statusCode).toBe(401);
  });

  it('should reject requests with wrong bearer token', async () => {
    app.setReady();
    const res = await app.inject({
      method: 'GET',
      url: '/api/status',
      headers: { authorization: 'Bearer wrong-token' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('should accept requests with correct bearer token when ready', async () => {
    app.setReady();
    const res = await app.inject({
      method: 'GET',
      url: '/api/status',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it('should return 409 when session is already active', async () => {
    app.setReady();
    // Pre-seed an active session
    app.setSessionState({ status: 'ACTIVE', aisup_session_id: 'aisup-abc12345' });

    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: '/tmp' }),
    });
    expect(res.statusCode).toBe(409);
    const body = res.json<{ error: string }>();
    expect(body.error).toMatch(/session.*active|operation.*progress/i);
  });

  it('should allow POST /api/sessions when no session exists', async () => {
    app.setReady();
    app.setSessionState(null);

    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: tmpDir }),
    });
    // 200 or 201 — session created (stub)
    expect([200, 201]).toContain(res.statusCode);
  });

  it('rejects POST /api/sessions when cwd exists but is not a directory', async () => {
    app.setReady();
    const filePath = join(tmpDir, 'not-a-dir');
    writeFileSync(filePath, 'x');

    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: filePath }),
    });

    expect(res.statusCode).toBe(400);
  });

  it('GET /api/status returns fresh persisted state (skill/failover changes) plus recovery guidance', async () => {
    await app.close();
    const sessionManager = {
      readState: vi.fn().mockReturnValue({
        aisup_session_id: 's1', status: 'ACTIVE', account: 'primary', cwd: '/x',
        tmux_name: 'aisup-s1', active_skill: '/spec', updated_at: '2026-06-01T00:00:00Z',
      }),
    };
    app = await createDaemonServer({ tokenPath, host: '127.0.0.1', port: 0, sessionManager: sessionManager as never });
    app.setReady();
    // Seed a STALE in-memory state missing active_skill.
    app.setSessionState({ status: 'ACTIVE', aisup_session_id: 's1' });

    const res = await app.inject({ method: 'GET', url: '/api/status', headers: { authorization: `Bearer ${token}` } });
    const body = res.json<{ session: { active_skill: string }; recovery_guidance: string | null }>();
    expect(body.session.active_skill).toBe('/spec'); // fresh, not the stale in-memory value
    expect(body.recovery_guidance).toBeTruthy();
  });

  it('GET /api/accounts includes usage and model from statusline telemetry', async () => {
    await app.close();
    const future = Math.floor(Date.now() / 1000) + 3600;
    const slDir = join(tmpDir, 'sl');
    const cfgDir = join(tmpDir, 'primary-cfg');
    mkdirSync(slDir, { recursive: true });
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(join(slDir, 'statusline-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.json'), JSON.stringify({
      session_id: 'x',
      transcript_path: join(cfgDir, 'projects', 'p', 'x.jsonl'),
      rate_limits: {
        five_hour: { used_percentage: 42, resets_at: future },
        seven_day: { used_percentage: 21, resets_at: future },
      },
      model: { id: 'claude-opus-4-8' },
    }));
    const accountRegistry = {
      getAll: vi.fn().mockReturnValue([
        { name: 'primary', configDir: cfgDir, priority: 1, enabled: true, state: 'HEALTHY', score: 60, cooldownUntil: null },
      ]),
    };
    app = await createDaemonServer({
      tokenPath, host: '127.0.0.1', port: 0,
      accountRegistry: accountRegistry as never,
      statuslineDir: slDir, statuslineFreshnessWindowS: 300,
    });
    app.setReady();

    const res = await app.inject({ method: 'GET', url: '/api/accounts', headers: { authorization: `Bearer ${token}` } });
    const acct = res.json<{ accounts: Array<{ five_hour_pct: number | null; model: string | null }> }>().accounts[0];
    expect(acct.five_hour_pct).toBe(42);
    expect(acct.model).toBe('claude-opus-4-8');
  });

  it('GET /api/accounts exposes cooldown and disabled-account visibility', async () => {
    await app.close();
    const accountRegistry = {
      getAll: vi.fn().mockReturnValue([
        { name: 'primary', configDir: '/a', priority: 1, enabled: true, state: 'COOLDOWN', score: 50, cooldownUntil: new Date('2026-06-01T01:00:00Z') },
        { name: 'account2', configDir: '/b', priority: 2, enabled: false, state: 'HEALTHY', score: null, cooldownUntil: null },
      ]),
    };
    app = await createDaemonServer({ tokenPath, host: '127.0.0.1', port: 0, accountRegistry: accountRegistry as never });
    app.setReady();

    const res = await app.inject({ method: 'GET', url: '/api/accounts', headers: { authorization: `Bearer ${token}` } });
    const body = res.json<{ accounts: Array<{ name: string; enabled: boolean; cooldown_until: string | null }> }>();
    expect(body.accounts).toHaveLength(2); // includes the disabled account
    expect(body.accounts.find((a) => a.name === 'account2')?.enabled).toBe(false);
    expect(body.accounts.find((a) => a.name === 'primary')?.cooldown_until).toBe('2026-06-01T01:00:00.000Z');
  });

  it('exposes a rehydrated EXHAUSTED session in /api/status and blocks new starts', async () => {
    await app.close();
    const sessionManager = {
      getBlockingSession: vi.fn().mockReturnValue({ status: 'EXHAUSTED', aisup_session_id: 'sess-ex' }),
    };
    app = await createDaemonServer({
      tokenPath, host: '127.0.0.1', port: 0,
      sessionManager: sessionManager as never,
    });
    app.setReady();
    // Simulates rehydration restoring EXHAUSTED visibility post-restart.
    app.setSessionState({ status: 'EXHAUSTED', aisup_session_id: 'sess-ex', hasTmux: false });

    const status = await app.inject({ method: 'GET', url: '/api/status', headers: { authorization: `Bearer ${token}` } });
    expect(status.json<{ session: { status: string } }>().session.status).toBe('EXHAUSTED');

    const start = await app.inject({
      method: 'POST', url: '/api/sessions',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: tmpDir }),
    });
    expect(start.statusCode).toBe(409);
    expect(start.json<{ exhausted: boolean }>().exhausted).toBe(true);
  });

  it('admits the scored winner after refreshing accounts (not the priority-order account)', async () => {
    await app.close();
    const registry = new AccountRegistry({
      accounts: [
        { name: 'primary', config_dir: '/tmp/primary', priority: 1, enabled: true },
        { name: 'account2', config_dir: '/tmp/account2', priority: 2, enabled: true },
      ],
    } as AisupConfig);
    // Both scores start null; the refresh callback populates them so the
    // lower-priority but higher-score account becomes the admission winner.
    let refreshed = false;
    const refreshAccounts = (): void => {
      refreshed = true;
      registry.setScore('primary', 20);
      registry.setScore('account2', 80);
    };
    const createSession = vi.fn().mockImplementation(async (args: { account: string }) => ({
      aisup_session_id: 'sess-xyz',
      account: args.account,
      tmux_name: 'aisup-sessxyz',
    }));
    const sessionManager = {
      getBlockingSession: vi.fn().mockReturnValue(null),
      createSession,
    };
    app = await createDaemonServer({
      tokenPath,
      host: '127.0.0.1',
      port: 0,
      sessionManager: sessionManager as never,
      accountRegistry: registry,
      journal: { append: vi.fn().mockResolvedValue(undefined) } as never,
      runnerConfig: { command: 'echo', args: [], env: {} },
      refreshAccounts,
    });
    app.setReady();
    app.setSessionState(null);

    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: tmpDir }),
    });

    expect(res.statusCode).toBe(201);
    const body = res.json<{ account: string }>();
    expect(refreshed).toBe(true);
    expect(body.account).toBe('account2');
    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({ account: 'account2' }));
  });

  it('passes DELETE /api/sessions force flag to SessionManager.stopSession', async () => {
    await app.close();
    const stopSession = vi.fn().mockResolvedValue(undefined);
    const sessionManager = {
      readState: vi.fn().mockReturnValue({
        aisup_session_id: 'sess-001',
        tmux_name: 'aisup-sess001',
      }),
      stopSession,
      getBlockingSession: vi.fn().mockReturnValue(null),
    };
    app = await createDaemonServer({
      tokenPath,
      host: '127.0.0.1',
      port: 0,
      sessionManager: sessionManager as never,
    });
    app.setReady();
    app.setSessionState({ status: 'ACTIVE', aisup_session_id: 'sess-001' });

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/sessions',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ force: true }),
    });

    expect(res.statusCode).toBe(200);
    expect(stopSession).toHaveBeenCalledWith('aisup-sess001', 'sess-001', { force: true });
  });

  it('captures a pre_stop cost snapshot and clears cost tracking on DELETE /api/sessions', async () => {
    await app.close();
    const captureCostSnapshot = vi.fn();
    const clearCostTracking = vi.fn();
    const sessionManager = {
      readState: vi.fn().mockReturnValue({ aisup_session_id: 'sess-001', tmux_name: 'aisup-sess001' }),
      stopSession: vi.fn().mockResolvedValue(undefined),
      getBlockingSession: vi.fn().mockReturnValue(null),
    };
    app = await createDaemonServer({
      tokenPath,
      host: '127.0.0.1',
      port: 0,
      sessionManager: sessionManager as never,
      journal: { append: vi.fn().mockResolvedValue(undefined) } as never,
      captureCostSnapshot,
      clearCostTracking,
    });
    app.setReady();
    app.setSessionState({ status: 'ACTIVE', aisup_session_id: 'sess-001' });

    await app.inject({
      method: 'DELETE',
      url: '/api/sessions',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ force: true }),
    });

    expect(captureCostSnapshot).toHaveBeenCalledWith('sess-001', 'pre_stop');
    expect(clearCostTracking).toHaveBeenCalledWith('sess-001');
  });

  it('captures a pre_manual_failover cost snapshot before a manual failover', async () => {
    await app.close();
    const captureCostSnapshot = vi.fn();
    const accounts = [
      { name: 'primary', configDir: join(tmpDir, 'p'), priority: 1, enabled: true, state: 'HEALTHY', score: null, cooldownUntil: null },
      { name: 'account2', configDir: join(tmpDir, 'a2'), priority: 2, enabled: true, state: 'HEALTHY', score: null, cooldownUntil: null },
    ];
    const sessionManager = {
      readState: vi.fn().mockReturnValue({
        aisup_session_id: 'sess-001', account: 'primary', claude_session_id: null,
        transcript_path: null, active_skill: null, plan_path: null, cwd: tmpDir,
      }),
      patchState: vi.fn(),
      createSession: vi.fn().mockResolvedValue({ aisup_session_id: 'sess-001', account: 'account2', tmux_name: 'aisup-sess001' }),
      getBlockingSession: vi.fn().mockReturnValue(null),
    };
    const accountRegistry = {
      getAll: vi.fn().mockReturnValue(accounts),
      get: vi.fn((n: string) => accounts.find((a) => a.name === n)),
    };
    app = await createDaemonServer({
      tokenPath,
      host: '127.0.0.1',
      port: 0,
      sessionManager: sessionManager as never,
      accountRegistry: accountRegistry as never,
      journal: { append: vi.fn().mockResolvedValue(undefined) } as never,
      runnerConfig: { command: 'echo', args: [], env: {} },
      captureCostSnapshot,
    });
    app.setReady();
    app.setSessionState({ status: 'ACTIVE', aisup_session_id: 'sess-001' });

    await app.inject({
      method: 'POST',
      url: '/api/failover',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ target_account: 'account2' }),
    });

    // The pre-switch snapshot is captured before performSwitch runs, regardless of its outcome.
    expect(captureCostSnapshot).toHaveBeenCalledWith('sess-001', 'pre_manual_failover');
  });

  it('GET /api/cost returns segment-aware rolling windows from the journal', async () => {
    await app.close();
    const journalPath = join(tmpDir, 'journal.jsonl');
    const ts = new Date().toISOString();
    const ev = (aisup: string, claude: string, account: string, cost: number): string =>
      JSON.stringify({ ts, event_type: 'cost.snapshot', aisup_session_id: aisup, claude_session_id: claude, account, details: { total_cost_usd: cost } });
    writeFileSync(journalPath, [ev('S1', 'c1', 'primary', 2), ev('S1', 'c1', 'primary', 5)].join('\n') + '\n');

    app = await createDaemonServer({ tokenPath, host: '127.0.0.1', port: 0, journalPath });
    app.setReady();

    const res = await app.inject({ method: 'GET', url: '/api/cost', headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ last_30d: { total_cost_usd: number } }>();
    expect(body.last_30d.total_cost_usd).toBe(5); // segment max, not the running sum 2+5
  });

  it('GET /api/gates returns the latest gate run', async () => {
    await app.close();
    const latest = { passed: false, results: [{ name: 'typecheck', status: 'failed', exitCode: 1, stdoutTail: '', stderrTail: 'err', required: true }] };
    app = await createDaemonServer({ tokenPath, host: '127.0.0.1', port: 0, getLatestGateRun: () => latest as never });
    app.setReady();

    const res = await app.inject({ method: 'GET', url: '/api/gates', headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ latest: { passed: boolean } | null }>().latest?.passed).toBe(false);
  });

  it('GET /api/gates returns null latest when none has run', async () => {
    await app.close();
    app = await createDaemonServer({ tokenPath, host: '127.0.0.1', port: 0, getLatestGateRun: () => null });
    app.setReady();

    const res = await app.inject({ method: 'GET', url: '/api/gates', headers: { authorization: `Bearer ${token}` } });
    expect(res.json<{ latest: unknown }>().latest).toBeNull();
  });

  it('POST /api/gates/run runs the configured gates and returns the result', async () => {
    await app.close();
    const runGates = vi.fn().mockResolvedValue({ passed: true, results: [{ name: 'typecheck', status: 'passed', exitCode: 0, stdoutTail: 'ok', stderrTail: '', required: true }] });
    app = await createDaemonServer({ tokenPath, host: '127.0.0.1', port: 0, runGates });
    app.setReady();

    const res = await app.inject({ method: 'POST', url: '/api/gates/run', headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
    expect(runGates).toHaveBeenCalled();
    expect(res.json<{ passed: boolean }>().passed).toBe(true);
  });

  it('GET /api/events?type=cost.snapshot returns only cost snapshots', async () => {
    await app.close();
    const journalPath = join(tmpDir, 'journal.jsonl');
    const ts = new Date().toISOString();
    writeFileSync(journalPath, [
      JSON.stringify({ ts, event_type: 'cost.snapshot', aisup_session_id: 'S1', details: { total_cost_usd: 1 } }),
      JSON.stringify({ ts, event_type: 'session.start', aisup_session_id: 'S1', details: {} }),
      JSON.stringify({ ts, event_type: 'cost.snapshot', aisup_session_id: 'S1', details: { total_cost_usd: 2 } }),
    ].join('\n') + '\n');

    app = await createDaemonServer({ tokenPath, host: '127.0.0.1', port: 0, journalPath });
    app.setReady();

    const res = await app.inject({ method: 'GET', url: '/api/events?type=cost.snapshot&limit=50', headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ events: Array<{ event_type: string }> }>();
    expect(body.events).toHaveLength(2);
    expect(body.events.every((e) => e.event_type === 'cost.snapshot')).toBe(true);
  });
});
