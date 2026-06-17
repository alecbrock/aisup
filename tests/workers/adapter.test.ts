import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { buildWorkerCommand, resolveRouting, composeEnvAllowlist } from '../../src/workers/adapter.js';
import type { WorkerAdapterConfig, WorkerRoutingConfig } from '../../src/config/schema.js';
import type { WorkerTask } from '../../src/workers/types.js';

function adapter(partial: Partial<WorkerAdapterConfig> = {}): WorkerAdapterConfig {
  return {
    name: 'codex',
    command: 'codex',
    args: [],
    prompt_via: 'arg',
    prompt_arg_flag: null,
    prompt_file_flag: null,
    env_allowlist: ['PATH', 'HOME'],
    timeout_seconds: 1800,
    enabled: true,
    ...partial,
  };
}

function task(partial: Partial<WorkerTask> = {}): WorkerTask {
  const now = new Date().toISOString();
  return {
    id: '11111111-1111-1111-1111-111111111111',
    task_type: 'implement',
    title: 't',
    prompt: 'do the thing',
    base_ref: 'HEAD',
    base_sha: 'sha',
    implementer: 'codex',
    reviewer: 'gemini',
    workspace_root: '/repo',
    created_at: now,
    updated_at: now,
    ...partial,
  };
}

describe('buildWorkerCommand', () => {
  const worktree = '/wt/abc';
  const stateDir = '/state/abc';

  it('arg prompt_via with no flag appends the prompt positionally', () => {
    const plan = buildWorkerCommand(adapter({ prompt_via: 'arg', args: ['run'] }), task(), worktree, stateDir);
    expect(plan.args).toEqual(['run', 'do the thing']);
    expect(plan.stdin).toBeNull();
    expect(plan.promptFile).toBeNull();
  });

  it('arg prompt_via with a flag inserts the flag before the prompt', () => {
    const plan = buildWorkerCommand(
      adapter({ prompt_via: 'arg', prompt_arg_flag: '-p', args: ['run'] }),
      task(),
      worktree,
      stateDir
    );
    expect(plan.args).toEqual(['run', '-p', 'do the thing']);
  });

  it('stdin prompt_via returns the prompt as stdin and no args appended', () => {
    const plan = buildWorkerCommand(adapter({ prompt_via: 'stdin', args: ['run'] }), task(), worktree, stateDir);
    expect(plan.stdin).toBe('do the thing');
    expect(plan.args).toEqual(['run']);
    expect(plan.promptFile).toBeNull();
  });

  it('file prompt_via returns promptFile under workerStateDir (not the worktree) with prompt contents', () => {
    const plan = buildWorkerCommand(
      adapter({ prompt_via: 'file', prompt_file_flag: '-f' }),
      task(),
      worktree,
      stateDir
    );
    expect(plan.promptFile).not.toBeNull();
    expect(plan.promptFile!.path.startsWith(stateDir)).toBe(true);
    expect(plan.promptFile!.path.startsWith(worktree)).toBe(false);
    expect(plan.promptFile!.contents).toBe('do the thing');
    expect(plan.args).toEqual(['-f', plan.promptFile!.path]);
  });

  it('env contains only effective-allowlist names + forced isolated HOME; excludes non-allowlisted vars', () => {
    process.env.AISUP_TEST_SEC_ONLY = 'secval';
    process.env.AISUP_TEST_NOT_ALLOWED = 'nope';
    try {
      const allowlist = composeEnvAllowlist(['AISUP_TEST_SEC_ONLY'], ['PATH']);
      expect(allowlist).toContain('AISUP_TEST_SEC_ONLY'); // present only in security list — proves the union
      const plan = buildWorkerCommand(adapter({ env_allowlist: allowlist }), task(), worktree, stateDir);
      expect(plan.env.AISUP_TEST_SEC_ONLY).toBe('secval');
      expect(plan.env.PATH).toBeDefined();
      expect(plan.env.AISUP_TEST_NOT_ALLOWED).toBeUndefined();
      expect(plan.env.HOME).toBe(join(worktree, '.home'));
    } finally {
      delete process.env.AISUP_TEST_SEC_ONLY;
      delete process.env.AISUP_TEST_NOT_ALLOWED;
    }
  });
});

describe('resolveRouting', () => {
  const adapters: Record<string, WorkerAdapterConfig> = {
    codex: adapter({ name: 'codex', enabled: true }),
    gemini: adapter({ name: 'gemini', command: 'gemini', enabled: true }),
    local: adapter({ name: 'local', command: 'llama', enabled: false }),
  };
  const routing: WorkerRoutingConfig = {
    default_implementer: 'codex',
    default_reviewer: 'gemini',
    by_task_type: { bugfix: { implementer: 'gemini', reviewer: 'codex' } },
  };

  it('honours by_task_type over defaults', () => {
    const r = resolveRouting('bugfix', routing, adapters);
    expect(r.implementer).toBe('gemini');
    expect(r.reviewer).toBe('codex');
    expect(r.degraded).toBe(false);
  });

  it('returns a reviewer != implementer when a second enabled adapter exists', () => {
    const r = resolveRouting('implement', routing, adapters);
    expect(r.implementer).toBe('codex');
    expect(r.reviewer).toBe('gemini');
    expect(r.degraded).toBe(false);
  });

  it('treats a disabled configured reviewer as unavailable and falls back to another enabled adapter', () => {
    const r = resolveRouting(
      'implement',
      { default_implementer: 'codex', default_reviewer: 'local', by_task_type: {} },
      adapters
    );
    expect(r.implementer).toBe('codex');
    expect(r.reviewer).toBe('gemini'); // local disabled → fall back to gemini
    expect(r.degraded).toBe(false);
  });

  it('flags degraded when only one enabled adapter remains', () => {
    const onlyCodex: Record<string, WorkerAdapterConfig> = {
      codex: adapter({ name: 'codex', enabled: true }),
      gemini: adapter({ name: 'gemini', enabled: false }),
    };
    const r = resolveRouting(
      'implement',
      { default_implementer: 'codex', default_reviewer: 'gemini', by_task_type: {} },
      onlyCodex
    );
    expect(r.implementer).toBe('codex');
    expect(r.reviewer).toBe('codex');
    expect(r.degraded).toBe(true);
  });
});
