import Fastify from 'fastify';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { canStartNewSession } from '../cli/pid.js';
import type { SessionInfo } from '../session/types.js';

export interface DaemonServerOptions {
  tokenPath: string;
  host: string;
  port: number;
}

declare module 'fastify' {
  interface FastifyInstance {
    setReady(): void;
    setSessionState(session: SessionInfo | null): void;
  }
}

export async function createDaemonServer(opts: DaemonServerOptions): Promise<FastifyInstance> {
  let ready = false;
  let sessionState: SessionInfo | null = null;
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
    const check = canStartNewSession(sessionState);
    if (!check.allowed) {
      const isExhausted = sessionState?.status === 'EXHAUSTED';
      return reply.status(409).send({ error: check.reason, exhausted: isExhausted });
    }

    const body = req.body as { cwd?: string; plan?: string } | undefined;
    const cwd = body?.cwd ?? process.cwd();

    // Validate cwd exists
    if (!existsSync(cwd)) {
      return reply.status(400).send({ error: `cwd does not exist or is not a directory: ${cwd}` });
    }

    // Stub: real session creation wired in Task 3
    return reply.status(201).send({ status: 'created', cwd, message: 'stub — wired in Task 3' });
  });

  app.delete('/api/sessions', async (_req, reply) => {
    return reply.send({ status: 'stopped', message: 'stub — wired in Task 3' });
  });

  app.get('/api/events', async (req, reply) => {
    const query = req.query as { limit?: string };
    const limit = parseInt(query.limit ?? '20', 10);
    return reply.send({ events: [], limit, note: 'read journal file for offline access' });
  });

  app.get('/api/accounts', async (_req, reply) => {
    return reply.send({ accounts: [] });
  });

  app.post('/api/failover', async (req, reply) => {
    const body = req.body as { target_account?: string } | undefined;
    if (!body?.target_account) {
      return reply.status(400).send({ error: 'target_account required' });
    }
    if (!sessionState || sessionState.status === 'STOPPED') {
      return reply.status(409).send({ error: 'No active session to failover' });
    }
    return reply.send({ target_account: body.target_account, launch_mode: 'stub', status: 'initiated' });
  });

  return app;
}
