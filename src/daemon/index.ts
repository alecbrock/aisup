import { join } from 'node:path';
import { homedir } from 'node:os';
import { createWriteStream, readdirSync, readFileSync, existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { loadConfig } from '../config/loader.js';
import { createJournalWriter } from '../journal/writer.js';
import { createDaemonServer } from './server.js';
import { writePidFile, removePidFile } from '../cli/pid.js';
import type { FastifyInstance } from 'fastify';
import type { SessionInfo } from '../session/types.js';

const AISUP_DIR = join(homedir(), '.aisup');
const PID_PATH = join(AISUP_DIR, 'daemon.pid');
const TOKEN_PATH = join(AISUP_DIR, 'api-token');
const LOG_PATH = join(AISUP_DIR, 'daemon.log');

async function rehydrateSessions(
  server: FastifyInstance,
  journal: ReturnType<typeof import('../journal/writer.js').createJournalWriter>
): Promise<void> {
  const sessionsDir = join(homedir(), '.aisup', 'sessions');
  if (!existsSync(sessionsDir)) return;

  // List live aisup tmux sessions
  let liveSessions: Set<string>;
  try {
    const out = execFileSync('tmux', ['list-sessions', '-F', '#{session_name}'], { encoding: 'utf8' });
    liveSessions = new Set(out.split('\n').filter((s) => s.startsWith('aisup-')));
  } catch {
    liveSessions = new Set();
  }

  // Reconcile persisted state files with live tmux sessions
  let rehydrated = 0;
  for (const sessionId of readdirSync(sessionsDir)) {
    const statePath = join(sessionsDir, sessionId, 'state.json');
    if (!existsSync(statePath)) continue;
    try {
      const state = JSON.parse(readFileSync(statePath, 'utf8')) as { status: string; tmux_name: string };
      const hasTmux = liveSessions.has(state.tmux_name);

      if (state.status === 'ACTIVE' || state.status === 'SWITCH_PENDING_AT_IDLE') {
        if (!hasTmux) {
          // Persisted active session with no live tmux — destroyed externally
          await journal.append({
            ts: new Date().toISOString(),
            event_type: 'session.destroyed_externally',
            aisup_session_id: sessionId,
            details: { persisted_status: state.status, tmux_name: state.tmux_name },
          });
        } else {
          // Restore session state into server
          server.setSessionState({ status: state.status as SessionInfo['status'], aisup_session_id: sessionId });
          rehydrated++;
        }
      }
    } catch {
      // skip corrupt state files
    }
  }

  await journal.append({
    ts: new Date().toISOString(),
    event_type: 'daemon.rehydrated',
    details: { rehydrated, live_tmux_count: liveSessions.size },
  });
}

async function main(): Promise<void> {
  await mkdir(AISUP_DIR, { recursive: true, mode: 0o700 });

  // Redirect stdout/stderr to log file (internal rotating not yet implemented — Task 12)
  const logStream = createWriteStream(LOG_PATH, { flags: 'a', mode: 0o600 });
  process.stdout.write = logStream.write.bind(logStream);
  process.stderr.write = logStream.write.bind(logStream);

  const config = await loadConfig();
  const journal = createJournalWriter(config.journal.path);

  const server = await createDaemonServer({
    tokenPath: TOKEN_PATH,
    host: '127.0.0.1',
    port: config.daemon.port,
  });

  await server.listen({ host: '127.0.0.1', port: config.daemon.port });

  await writePidFile(PID_PATH, { pid: process.pid, port: config.daemon.port });

  await journal.append({
    ts: new Date().toISOString(),
    event_type: 'daemon.started',
    details: { pid: process.pid, port: config.daemon.port },
  });

  // Rehydrate persisted sessions — reconcile state files with live tmux sessions
  await rehydrateSessions(server, journal);
  server.setReady();

  await journal.append({
    ts: new Date().toISOString(),
    event_type: 'daemon.ready',
    details: {},
  });

  const shutdown = async (signal: string): Promise<void> => {
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
}

main().catch((err: unknown) => {
  process.stderr.write(`[aisup daemon] fatal: ${String(err)}\n`);
  process.exit(1);
});
