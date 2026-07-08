import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { FastifyInstance } from 'fastify';
import { createDaemonServer } from '../../src/daemon/server.js';
import { AccountRegistry } from '../../src/accounts/registry.js';
import type { AisupConfig } from '../../src/config/schema.js';

/**
 * C1 — GET /api/overview aggregates session, per-account headroom, worker queue,
 * cost-today, and recent events into ONE response (the payload behind
 * `aisup health`/`aisup watch`, Slack `!health`, and the D1 dashboard).
 */
describe('GET /api/overview (C1 unified snapshot)', () => {
  let tmpDir: string;
  let tokenPath: string;
  let journalPath: string;
  let token: string;
  let app: FastifyInstance;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'aisup-overview-'));
    mkdirSync(join(tmpDir, '.aisup'), { mode: 0o700 });
    token = 'test-bearer-token-overview';
    tokenPath = join(tmpDir, '.aisup', 'api-token');
    writeFileSync(tokenPath, token, { mode: 0o600 });

    // A journal with a cost snapshot (feeds cost_today) + a switch event (feeds recent_events).
    journalPath = join(tmpDir, '.aisup', 'journal.jsonl');
    const nowIso = new Date().toISOString();
    writeFileSync(
      journalPath,
      [
        JSON.stringify({ ts: nowIso, event_type: 'cost.snapshot', account: 'primary', session_id: 'sess-1', details: { total_cost_usd: 1.25 } }),
        JSON.stringify({ ts: nowIso, event_type: 'account.switch', account: 'account2', details: { reason: 'rate_limit_soft' } }),
      ].join('\n') + '\n',
    );
  });

  afterEach(async () => {
    await app.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns session + accounts + workers + cost_today + recent_events in one response', async () => {
    const registry = new AccountRegistry({
      accounts: [
        { name: 'primary', config_dir: join(tmpDir, 'primary'), priority: 1, enabled: true },
        { name: 'account2', config_dir: join(tmpDir, 'account2'), priority: 2, enabled: true },
      ],
    } as AisupConfig);

    const listWorkers = (): unknown[] => [
      { id: 'w1', status: 'QUEUED' },
      { id: 'w2', status: 'RUNNING' },
      { id: 'w3', status: 'AWAITING_APPROVAL' },
    ];

    app = await createDaemonServer({
      tokenPath,
      host: '127.0.0.1',
      port: 0,
      accountRegistry: registry,
      journalPath,
      listWorkers: listWorkers as never,
    });
    app.setReady();
    app.setSessionState({ status: 'ACTIVE', aisup_session_id: 'sess-1', account: 'primary' });

    const res = await app.inject({
      method: 'GET',
      url: '/api/overview',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{
      session: { status?: string; account?: string } | null;
      accounts: Array<{ name: string }>;
      workers: { total: number; queued: number; running: number; awaiting_approval: number } | null;
      cost_today: { total_cost_usd: number };
      recent_events: Array<{ event_type: string }>;
      daemon: { ok: boolean };
    }>();

    expect(body.session?.status).toBe('ACTIVE');
    expect(body.accounts.map((a) => a.name)).toEqual(['primary', 'account2']);
    expect(body.workers).toEqual({ total: 3, queued: 1, running: 1, awaiting_approval: 1 });
    expect(body.cost_today.total_cost_usd).toBeCloseTo(1.25);
    expect(body.recent_events.map((e) => e.event_type)).toContain('account.switch');
    expect(body.daemon.ok).toBe(true);
  });

  it('composes an empty-but-valid snapshot when no workers/journal are wired', async () => {
    app = await createDaemonServer({ tokenPath, host: '127.0.0.1', port: 0 });
    app.setReady();
    app.setSessionState(null);

    const res = await app.inject({
      method: 'GET',
      url: '/api/overview',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{
      session: unknown;
      accounts: unknown[];
      workers: unknown;
      cost_today: { total_cost_usd: number };
      recent_events: unknown[];
    }>();
    expect(body.accounts).toEqual([]);
    expect(body.workers).toBeNull();
    expect(body.cost_today.total_cost_usd).toBe(0);
    expect(body.recent_events).toEqual([]);
  });
});
