import { join } from 'node:path';
import { aisupHome } from '../../config/paths.js';
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { WorkerStore } from '../../workers/store.js';
import { redactTails } from '../../workers/redact.js';
import type { WorkerState } from '../../workers/types.js';
import type { ProviderUsageReport } from '../../providers/report.js';

const WORKER_TERMINAL = new Set(['MERGED', 'FAILED', 'REJECTED', 'CANCELLED']);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const TOKEN_PATH = join(aisupHome(), 'api-token');
const PID_PATH = join(aisupHome(), 'daemon.pid');

export interface DispatchBody {
  task_type: string;
  prompt: string;
  title: string;
  implementer?: string;
  reviewer?: string;
  base_ref?: string;
  workspace?: string;
}

export interface WorkerDispatchOpts {
  taskType?: string;
  prompt?: string;
  title?: string;
  implementer?: string;
  reviewer?: string;
  base?: string;
  workspace?: string;
}

/** Build the POST /api/workers body, loading an @file prompt and defaulting the title (LO-004). */
export async function buildDispatchBody(opts: WorkerDispatchOpts): Promise<DispatchBody> {
  let prompt = opts.prompt ?? '';
  if (prompt.startsWith('@')) {
    prompt = await readFile(prompt.slice(1), 'utf8');
  }
  const task_type = opts.taskType ?? 'implement';
  const title = opts.title ?? prompt.slice(0, 80);
  const body: DispatchBody = { task_type, prompt, title };
  if (opts.implementer) body.implementer = opts.implementer;
  if (opts.reviewer) body.reviewer = opts.reviewer;
  if (opts.base) body.base_ref = opts.base;
  if (opts.workspace) body.workspace = opts.workspace;
  return body;
}

/** Build a RequestInit; a body adds content-type: application/json + serialized JSON (LO-003). */
export function buildRequestInit(method: 'GET' | 'POST', token: string, body?: unknown): RequestInit {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  return init;
}

/** Returns the Response (any status) or null when the daemon is unreachable. */
async function daemonRequest(path: string, method: 'GET' | 'POST', body?: unknown): Promise<Response | null> {
  if (!existsSync(PID_PATH)) return null;
  try {
    const { port } = JSON.parse(await readFile(PID_PATH, 'utf8')) as { port: number };
    const token = (await readFile(TOKEN_PATH, 'utf8')).trim();
    return await fetch(`http://127.0.0.1:${port}${path}`, buildRequestInit(method, token, body));
  } catch {
    return null;
  }
}

export function formatWorkerStatus(w: WorkerState): string {
  const lines = [
    `Worker ${w.task.id}`,
    `  status:      ${w.status}${w.progress ? ` — ${w.progress}` : ''}`,
    `  type:        ${w.task.task_type}`,
    `  implementer: ${w.task.implementer}   reviewer: ${w.task.reviewer ?? '-'}`,
  ];
  if (w.output) lines.push(`  changed:     ${w.output.changed_files.join(', ') || '(none)'}`);
  if (w.validation) {
    lines.push(`  gates:       ${w.validation.passed ? 'passed' : `FAILED (${w.validation.failed_gates.join(', ')})`}`);
  }
  if (w.review) lines.push(`  review:      ${w.review.verdict}${w.review.degraded ? ' (degraded)' : ''}`);
  const a = w.approval;
  lines.push(`  approval:    ${a.granted ? `granted by ${a.by}` : a.decided ? 'denied' : 'pending'}`);
  if (w.tried_candidates && w.tried_candidates.length > 0) {
    lines.push('  tried:');
    for (const c of w.tried_candidates) {
      const label = c.provider === 'claude' ? `claude:${c.account ?? '?'}` : c.provider;
      const role = c.role ? ` [${c.role}]` : '';
      lines.push(`    - ${label}${role}: ${c.reason}`);
    }
  }
  return lines.join('\n');
}

export function formatWorkerList(ws: WorkerState[]): string {
  if (ws.length === 0) return 'No workers.';
  return ws.map((w) => `${w.task.id}  ${w.status.padEnd(18)} ${w.task.task_type.padEnd(10)} ${w.task.title}`).join('\n');
}

export function formatWorkerReview(w: WorkerState): string {
  if (!w.review) return `Worker ${w.task.id}: no review recorded.`;
  const lines = [`Review by ${w.review.reviewer}: ${w.review.verdict.toUpperCase()}${w.review.degraded ? ' (degraded same-model)' : ''}`];
  for (const f of w.review.findings) lines.push(`  [${f.severity}] ${f.summary}`);
  if (w.review.raw_output_tail) lines.push('', w.review.raw_output_tail);
  return lines.join('\n');
}

export function formatWorkerLogs(w: WorkerState): string {
  const lines = [`Worker ${w.task.id} logs:`];
  if (w.output) {
    lines.push(`  artifact: ${w.output.patch_path || '(none)'}`);
    lines.push('  --- stdout ---', w.output.stdout_tail || '(empty)');
    lines.push('  --- stderr ---', w.output.stderr_tail || '(empty)');
  } else {
    lines.push('  (no output captured yet)');
  }
  return lines.join('\n');
}

/** Render the per-provider usage readout: claude account headroom + basis, codex remaining tokens vs budget. */
export function formatProviderUsage(report: ProviderUsageReport): string {
  if (!report.roles.length) return 'No provider roles configured.';
  const lines: string[] = [];
  for (const role of report.roles) {
    lines.push(`${role.role}:`);
    if (!role.candidates.length) { lines.push('  (no candidates)'); continue; }
    for (const c of role.candidates) {
      const mark = c.available ? 'available' : 'UNAVAILABLE';
      const detail: string[] = [];
      if (c.headroom_pct !== null) detail.push(`headroom ${Math.round(c.headroom_pct)}%`);
      if (c.remaining_tokens !== null) detail.push(`${c.remaining_tokens} tokens left`);
      detail.push(`basis=${c.basis}`);
      if (!c.available && c.reason) detail.push(`(${c.reason})`);
      lines.push(`  ${c.label.padEnd(18)} ${mark.padEnd(12)} ${detail.join('  ')}`);
    }
  }
  return lines.join('\n');
}

const DAEMON_REQUIRED = 'Daemon not running — worker commands require the daemon. Start it with `aisup daemon start`.';

/**
 * Report a failed worker request distinguishing an UNREACHABLE daemon (`res === null`) from a
 * reachable daemon that refused the endpoint (F-1): a 503 means workers are disabled, so surface the
 * server's own reason ("workers not enabled") instead of the misleading "Daemon not running".
 */
async function reportWorkerRequestFailure(res: Response | null): Promise<void> {
  if (!res) { console.log(DAEMON_REQUIRED); return; }
  const json = (await res.json().catch(() => ({}))) as { error?: string };
  console.log(json.error ?? `Request failed (${res.status}).`);
}

export async function workerDispatch(opts: WorkerDispatchOpts): Promise<void> {
  const body = await buildDispatchBody(opts);
  const res = await daemonRequest('/api/workers', 'POST', body);
  if (!res) return void console.log(DAEMON_REQUIRED);
  if (res.status === 202) {
    const json = (await res.json()) as { id: string; status: string };
    console.log(`Dispatched worker ${json.id} (${json.status})`);
  } else {
    const json = (await res.json().catch(() => ({}))) as { error?: string };
    console.log(`Dispatch failed: ${json.error ?? res.status}`);
  }
}

async function fetchWorker(id: string): Promise<WorkerState | null> {
  const res = await daemonRequest(`/api/workers/${id}`, 'GET');
  if (!res || !res.ok) return null;
  return ((await res.json()) as { worker: WorkerState }).worker;
}

export async function workerList(opts: { json?: boolean } = {}): Promise<void> {
  const res = await daemonRequest('/api/workers', 'GET');
  if (!res || !res.ok) return void (await reportWorkerRequestFailure(res));
  const body = (await res.json()) as { workers: WorkerState[] };
  if (opts.json) return void console.log(JSON.stringify(body, null, 2));
  console.log(formatWorkerList(body.workers));
}

export async function workerProviders(opts: { json?: boolean } = {}): Promise<void> {
  const res = await daemonRequest('/api/workers/providers', 'GET');
  if (!res || !res.ok) return void (await reportWorkerRequestFailure(res));
  const report = (await res.json()) as ProviderUsageReport;
  if (opts.json) return void console.log(JSON.stringify(report, null, 2));
  console.log(formatProviderUsage(report));
}

export async function workerStatus(id: string, opts: { json?: boolean } = {}): Promise<void> {
  const worker = await fetchWorker(id);
  if (!worker) return void console.log(DAEMON_REQUIRED);
  if (opts.json) return void console.log(JSON.stringify(worker, null, 2));
  console.log(formatWorkerStatus(worker));
}

export async function workerReview(id: string): Promise<void> {
  const worker = await fetchWorker(id);
  if (!worker) return void console.log(DAEMON_REQUIRED);
  console.log(formatWorkerReview(worker));
}

export async function workerLogs(id: string, opts: { follow?: boolean; pollMs?: number } = {}): Promise<void> {
  if (opts.follow) return workerLogsFollow(id, opts.pollMs ?? 400);
  const worker = await fetchWorker(id);
  if (!worker) return void console.log(DAEMON_REQUIRED);
  console.log(formatWorkerLogs(worker));
}

/**
 * C12: tail the worker's live stdout (`<store>/<id>/live.log`) as it runs, redacting each read,
 * and exit cleanly when the worker reaches a terminal state. Condition-based polling, no fixed sleep
 * beyond the poll interval; reads the local store directly (no daemon round-trip per tick).
 */
export async function workerLogsFollow(id: string, pollMs = 400): Promise<void> {
  const store = new WorkerStore();
  let logPath: string;
  try {
    logPath = join(store.dir(id), 'live.log');
  } catch {
    console.log(`Invalid worker id "${id}".`);
    return;
  }
  let offset = 0;
  for (;;) {
    if (existsSync(logPath)) {
      const buf = readFileSync(logPath);
      if (buf.length > offset) {
        process.stdout.write(redactTails(buf.subarray(offset).toString('utf8')));
        offset = buf.length;
      }
    }
    const state = store.read(id);
    if (!state) { console.log(`Worker ${id} not found.`); return; }
    if (WORKER_TERMINAL.has(state.status)) {
      process.stdout.write(`\n[worker ${state.status}]\n`);
      return;
    }
    await sleep(pollMs);
  }
}

async function workerAction(id: string, action: 'approve' | 'deny' | 'cancel'): Promise<void> {
  const res = await daemonRequest(`/api/workers/${id}/${action}`, 'POST', {});
  if (!res) return void console.log(DAEMON_REQUIRED);
  if (res.ok) {
    console.log(`Worker ${id}: ${action} ok`);
  } else {
    const json = (await res.json().catch(() => ({}))) as { error?: string };
    console.log(`Worker ${id}: ${action} failed (${json.error ?? res.status})`);
  }
}

export const workerApprove = (id: string): Promise<void> => workerAction(id, 'approve');
export const workerDeny = (id: string): Promise<void> => workerAction(id, 'deny');
export const workerCancel = (id: string): Promise<void> => workerAction(id, 'cancel');

/** C6: re-dispatch a failed worker; prints the new worker id on success. */
export async function workerRetry(id: string): Promise<void> {
  const res = await daemonRequest(`/api/workers/${id}/retry`, 'POST', {});
  if (!res) return void console.log(DAEMON_REQUIRED);
  const json = (await res.json().catch(() => ({}))) as { id?: string; error?: string };
  if (res.ok) console.log(`Worker ${id}: retried → new worker ${json.id}`);
  else console.log(`Worker ${id}: retry failed (${json.error ?? res.status})`);
}

/** C10: revert a merged worker's patch from the working tree. */
export async function workerUndo(id: string): Promise<void> {
  const res = await daemonRequest(`/api/workers/${id}/undo`, 'POST', {});
  if (!res) return void console.log(DAEMON_REQUIRED);
  const json = (await res.json().catch(() => ({}))) as { error?: string };
  if (res.ok) console.log(`Worker ${id}: merge reverted.`);
  else if (json.error === 'diverged') console.log(`Worker ${id}: cannot undo — the working tree has diverged from the merged patch. Revert your local edits or undo manually.`);
  else console.log(`Worker ${id}: undo failed (${json.error ?? res.status})`);
}

/** C10: list orphaned aisup worktrees, and with --force remove them. */
export async function workerCleanup(opts: { force?: boolean }): Promise<void> {
  const res = await daemonRequest('/api/workers/cleanup', 'POST', { force: opts.force ?? false });
  if (!res) return void console.log(DAEMON_REQUIRED);
  const json = (await res.json().catch(() => ({}))) as { orphans?: string[]; removed?: string[]; error?: string };
  if (!res.ok) return void console.log(`Cleanup failed (${json.error ?? res.status})`);
  const orphans = json.orphans ?? [];
  if (orphans.length === 0) return void console.log('No orphaned worktrees.');
  if (opts.force) console.log(`Removed ${json.removed?.length ?? 0} orphaned worktree(s):\n${(json.removed ?? []).map((p) => `  ${p}`).join('\n')}`);
  else console.log(`Orphaned worktrees (run with --force to remove):\n${orphans.map((p) => `  ${p}`).join('\n')}`);
}
