import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDaemonServer } from '../../src/daemon/server.js';
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
});
