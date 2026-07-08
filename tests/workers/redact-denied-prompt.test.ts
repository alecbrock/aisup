import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { WorkerStore } from '../../src/workers/store.js';
import type { WorkerTask } from '../../src/workers/types.js';

const WID = randomUUID();

/** F-4: an opt-in store helper redacts a security-denied task's prompt/title (secrets may be present
 *  and a denied task is never retried). Default behavior (no redaction) is exercised elsewhere. */
function task(): WorkerTask {
  return {
    id: WID, task_type: 'implement', title: 'leak SECRET=abc', prompt: 'do X with token SECRET=abc123',
    base_ref: 'HEAD', base_sha: 'sha', implementer: 'codex', reviewer: 'gemini',
    workspace_root: '/repo', created_at: 'now', updated_at: 'now',
  } as WorkerTask;
}

describe('F-4 redactDeniedTask', () => {
  let dir: string;
  let store: WorkerStore;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'aisup-rdp-')); store = new WorkerStore(dir); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('replaces the persisted prompt and title with placeholders, keeping the secret out of state.json', () => {
    store.create(task());
    const redacted = store.redactDeniedTask(WID);
    expect(redacted.task.prompt).not.toContain('SECRET=abc123');
    expect(redacted.task.title).not.toContain('SECRET');
    expect(redacted.task.prompt).toMatch(/redact/i);
    // Persisted on disk too.
    const reread = store.read(WID);
    expect(reread?.task.prompt).not.toContain('SECRET');
  });

  it('leaves other task fields intact (id, base_sha)', () => {
    store.create(task());
    const redacted = store.redactDeniedTask(WID);
    expect(redacted.task.id).toBe(WID);
    expect(redacted.task.base_sha).toBe('sha');
  });
});
