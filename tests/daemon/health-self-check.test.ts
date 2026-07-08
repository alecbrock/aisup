import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { FastifyInstance } from 'fastify';
import { LoopManager } from '../../src/daemon/loop-manager.js';
import { createDaemonServer } from '../../src/daemon/server.js';

function makeLoopManager(): LoopManager {
  return new LoopManager({
    rateLimitIntervalMs: 1000, healthIntervalMs: 1000, recoveryIntervalMs: 1000, idleIntervalMs: 1000,
    onThresholdBreach: () => {}, onCrashDetected: () => {}, onHealthResult: () => {}, onIdle: () => {},
  });
}

describe('D3: daemon health self-check', () => {
  it('reports a ticked loop as fresh and a long-silent / never-ticked loop as stale', () => {
    const lm = makeLoopManager();
    const t0 = 1_000_000;
    lm.markTick('health', t0);
    lm.markTick('rate_limit', t0);

    const fresh = lm.getLoopHealth(t0 + 500); // within interval
    expect(fresh.find((l) => l.loop === 'health')!.stale).toBe(false);
    expect(fresh.find((l) => l.loop === 'idle')!.stale).toBe(true); // never ticked

    const later = lm.getLoopHealth(t0 + 10_000); // > 3× the 1s interval
    expect(later.find((l) => l.loop === 'health')!.stale).toBe(true);
    expect(later.find((l) => l.loop === 'rate_limit')!.stale).toBe(true);
  });

  describe('GET /api/health exposes per-loop liveness', () => {
    let tmpDir: string;
    let app: FastifyInstance;
    beforeEach(async () => {
      tmpDir = mkdtempSync(join(tmpdir(), 'aisup-hsc-'));
      mkdirSync(join(tmpDir, '.aisup'), { mode: 0o700 });
      const tokenPath = join(tmpDir, '.aisup', 'api-token');
      writeFileSync(tokenPath, 'tok', { mode: 0o600 });
      app = await createDaemonServer({
        tokenPath, host: '127.0.0.1', port: 0,
        getLoopHealth: () => [
          { loop: 'health', last_tick: '2026-06-30T12:00:00Z', stale: false },
          { loop: 'idle', last_tick: null, stale: true },
        ],
      });
    });
    afterEach(async () => { await app.close(); rmSync(tmpDir, { recursive: true, force: true }); });

    it('/api/health lists loops with staleness (a stalled loop is visible)', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/health' });
      expect(res.statusCode).toBe(200);
      const body = res.json<{ loops: Array<{ loop: string; stale: boolean }> }>();
      expect(body.loops.find((l) => l.loop === 'idle')!.stale).toBe(true);
      expect(body.loops.find((l) => l.loop === 'health')!.stale).toBe(false);
    });
  });
});
