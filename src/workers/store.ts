import { mkdirSync, writeFileSync, readFileSync, existsSync, renameSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { aisupHome } from '../config/paths.js';
import type { WorkerState, WorkerTask, TriedCandidate } from './types.js';

/** UUID shape (any version) — worker ids are generated UUIDs; reject anything else to prevent traversal. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Atomic on-disk store of worker state under <stateDir>/<id>/state.json — mirrors SessionManager.writeState. */
export class WorkerStore {
  private readonly stateDir: string;

  constructor(stateDir?: string) {
    this.stateDir = stateDir ?? join(aisupHome(), 'workers');
  }

  private validateId(id: string): string {
    if (typeof id !== 'string' || !UUID_RE.test(id)) {
      throw new Error(`WorkerStore: invalid worker id "${id}" — must be a UUID`);
    }
    return id;
  }

  dir(id: string): string {
    return join(this.stateDir, this.validateId(id));
  }

  private statePath(id: string): string {
    return join(this.dir(id), 'state.json');
  }

  private write(state: WorkerState): void {
    const dir = this.dir(state.task.id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = this.statePath(state.task.id);
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    renameSync(tmp, path);
  }

  create(task: WorkerTask): WorkerState {
    const now = new Date().toISOString();
    const state: WorkerState = {
      task,
      status: 'QUEUED',
      worktree_path: null,
      output: null,
      review: null,
      validation: null,
      approval: { decided: false, granted: false, by: null, at: null },
      error_summary: null,
      created_at: now,
      updated_at: now,
    };
    this.write(state);
    return state;
  }

  read(id: string): WorkerState | null {
    const path = this.statePath(id);
    if (!existsSync(path)) return null;
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as WorkerState;
    } catch {
      return null;
    }
  }

  patch(id: string, partial: Partial<WorkerState>): WorkerState {
    const current = this.read(id);
    if (!current) {
      throw new Error(`WorkerStore: cannot patch unknown worker "${id}"`);
    }
    const updated: WorkerState = {
      ...current,
      ...partial,
      task: partial.task ?? current.task,
      updated_at: new Date().toISOString(),
    };
    this.write(updated);
    return updated;
  }

  /** C3: append a failed candidate to the worker's durable tried_candidates list (append-only). */
  appendTriedCandidate(id: string, entry: TriedCandidate): WorkerState {
    const current = this.read(id);
    if (!current) throw new Error(`WorkerStore: cannot record tried candidate for unknown worker "${id}"`);
    return this.patch(id, { tried_candidates: [...(current.tried_candidates ?? []), entry] });
  }

  /**
   * F-4 (opt-in): replace a security-denied task's prompt/title with placeholders. The operator's
   * input may carry secrets and a denied task is never retried (so the prompt isn't needed). Other
   * task fields are preserved. Callers gate this on `workers.security.redact_denied_prompts`.
   */
  redactDeniedTask(id: string): WorkerState {
    const current = this.read(id);
    if (!current) throw new Error(`WorkerStore: cannot redact unknown worker "${id}"`);
    return this.patch(id, {
      task: { ...current.task, prompt: '[redacted: security-denied]', title: '[redacted]' },
    });
  }

  list(): WorkerState[] {
    if (!existsSync(this.stateDir)) return [];
    const out: WorkerState[] = [];
    for (const entry of readdirSync(this.stateDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !UUID_RE.test(entry.name)) continue;
      const path = join(this.stateDir, entry.name, 'state.json');
      if (!existsSync(path)) continue;
      try {
        out.push(JSON.parse(readFileSync(path, 'utf8')) as WorkerState);
      } catch {
        // skip corrupt entry
      }
    }
    return out;
  }
}
