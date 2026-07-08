import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { FastifyInstance } from 'fastify';
import { createDaemonServer } from '../../src/daemon/server.js';

describe('D1: read-only mobile dashboard', () => {
  let tmpDir: string;
  let tokenPath: string;
  let token: string;
  let app: FastifyInstance;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'aisup-dash-'));
    mkdirSync(join(tmpDir, '.aisup'), { mode: 0o700 });
    token = 'secret-daemon-token';
    tokenPath = join(tmpDir, '.aisup', 'api-token');
    writeFileSync(tokenPath, token, { mode: 0o600 });
    app = await createDaemonServer({ tokenPath, host: '127.0.0.1', port: 0 });
    app.setReady();
    app.setSessionState({ status: 'ACTIVE', aisup_session_id: 'sess-1', account: 'primary' });
  });
  afterEach(async () => { await app.close(); rmSync(tmpDir, { recursive: true, force: true }); });

  const cookieFrom = (res: { headers: Record<string, unknown> }): string => {
    const sc = res.headers['set-cookie'];
    const raw = Array.isArray(sc) ? sc[0] : String(sc);
    return raw.split(';')[0]; // "aisup_dash=<value>"
  };

  it('serves the dashboard shell unauthenticated (no token in URL)', async () => {
    const res = await app.inject({ method: 'GET', url: '/dashboard' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.body).toMatch(/aisup/);
    expect(res.body).not.toContain('?token='); // never puts the token in a URL
  });

  it('rejects /api/overview without a bearer or cookie', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/overview' });
    expect(res.statusCode).toBe(401);
  });

  it('rejects the token exchange with a wrong token', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/dashboard/session',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 'wrong' }),
    });
    expect(res.statusCode).toBe(401);
  });

  it('exchanges the token for an HttpOnly cookie that reads /api/overview', async () => {
    const exchange = await app.inject({
      method: 'POST', url: '/api/dashboard/session',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }),
    });
    expect(exchange.statusCode).toBe(200);
    const setCookie = String(exchange.headers['set-cookie']);
    expect(setCookie).toMatch(/aisup_dash=/);
    expect(setCookie).toMatch(/HttpOnly/);

    const overview = await app.inject({ method: 'GET', url: '/api/overview', headers: { cookie: cookieFrom(exchange) } });
    expect(overview.statusCode).toBe(200);
    expect(overview.json<{ session: { status: string } }>().session.status).toBe('ACTIVE');
  });

  it('does NOT let the dashboard cookie reach a control route', async () => {
    const exchange = await app.inject({
      method: 'POST', url: '/api/dashboard/session',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }),
    });
    const cookie = cookieFrom(exchange);
    // A control route (failover) must reject the read-only cookie.
    const res = await app.inject({
      method: 'POST', url: '/api/failover',
      headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ target_account: 'account2' }),
    });
    expect(res.statusCode).toBe(401);
  });
});
