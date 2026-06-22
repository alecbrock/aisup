import { join } from 'node:path';
import { homedir } from 'node:os';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import type { WorkerState } from '../../workers/types.js';
import type { ProviderUsageReport } from '../../providers/report.js';

const TOKEN_PATH = join(homedir(), '.aisup', 'api-token');
const PID_PATH = join(homedir(), '.aisup', 'daemon.pid');

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
    `  status:      ${w.status}`,
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
  if (!res || !res.ok) return void console.log(DAEMON_REQUIRED);
  const body = (await res.json()) as { workers: WorkerState[] };
  if (opts.json) return void console.log(JSON.stringify(body, null, 2));
  console.log(formatWorkerList(body.workers));
}

export async function workerProviders(opts: { json?: boolean } = {}): Promise<void> {
  const res = await daemonRequest('/api/workers/providers', 'GET');
  if (!res || !res.ok) return void console.log(DAEMON_REQUIRED);
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

export async function workerLogs(id: string): Promise<void> {
  const worker = await fetchWorker(id);
  if (!worker) return void console.log(DAEMON_REQUIRED);
  console.log(formatWorkerLogs(worker));
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
