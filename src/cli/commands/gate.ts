import { join } from 'node:path';
import { aisupHome } from '../../config/paths.js';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { loadConfig } from '../../config/loader.js';
import { createJournalWriter } from '../../journal/writer.js';
import { runGates } from '../../gates/engine.js';
import type { GateRunResult } from '../../gates/types.js';

const TOKEN_PATH = join(aisupHome(), 'api-token');
const PID_PATH = join(aisupHome(), 'daemon.pid');

/** Human-readable summary of a gate run (pure — used by both `aisup gate` and `aisup gate run`). */
export function formatGateRun(result: GateRunResult): string {
  const lines = [`Gates: ${result.passed ? 'PASSED' : 'FAILED'}`];
  for (const r of result.results) {
    lines.push(`  ${r.status.toUpperCase()} ${r.name}${r.required ? '' : ' (optional)'}`);
  }
  return lines.join('\n');
}

async function daemonRequest(path: string, method: 'GET' | 'POST'): Promise<Response | null> {
  if (!existsSync(PID_PATH)) return null;
  try {
    const { port } = JSON.parse(await readFile(PID_PATH, 'utf8')) as { port: number };
    const token = (await readFile(TOKEN_PATH, 'utf8')).trim();
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { authorization: `Bearer ${token}` } });
    return res.ok ? res : null;
  } catch {
    return null;
  }
}

/** `aisup gate` — show the latest gate run (from the running daemon). */
export async function showGates(opts: { json?: boolean } = {}): Promise<void> {
  const res = await daemonRequest('/api/gates', 'GET');
  if (!res) {
    console.log('Daemon not running — gate status is reported by the running daemon. Use `aisup gate run`.');
    return;
  }
  const body = await res.json() as { latest: GateRunResult | null };
  if (opts.json) { console.log(JSON.stringify(body, null, 2)); return; }
  if (!body.latest) { console.log('No gate run recorded yet.'); return; }
  console.log(formatGateRun(body.latest));
}

/** `aisup gate run` — run the configured gates now (online via daemon, else locally). */
export async function runGateCommand(opts: { json?: boolean } = {}): Promise<void> {
  let result: GateRunResult;
  const res = await daemonRequest('/api/gates/run', 'POST');
  if (res) {
    result = await res.json() as GateRunResult;
  } else {
    const config = await loadConfig();
    const journal = createJournalWriter(config.journal.path);
    result = await runGates(config.gates.gates, { journal, defaultCwd: process.cwd() });
  }
  if (opts.json) { console.log(JSON.stringify(result, null, 2)); }
  else { console.log(formatGateRun(result)); }
  // F-5: non-zero exit when a gate fails so CI can gate on it; 0 on pass. `exitCode` (not `exit()`)
  // lets buffered stdout flush and keeps the function unit-testable.
  process.exitCode = result.passed ? 0 : 1;
}
