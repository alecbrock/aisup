import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { validateWorkerOutput } from '../../src/workers/validation.js';
import type { GateCommandConfig } from '../../src/config/schema.js';
import type { GateRunner } from '../../src/gates/types.js';
import type { JournalEvent, JournalWriter } from '../../src/journal/types.js';

function spyJournal(): { journal: JournalWriter; events: JournalEvent[] } {
  const events: JournalEvent[] = [];
  return { events, journal: { append: async (e) => { events.push(e); } } };
}

function gate(partial: Partial<GateCommandConfig>): GateCommandConfig {
  return {
    name: 'g',
    command: 'true',
    args: [],
    timeout_seconds: 30,
    required: true,
    cwd: null,
    ...partial,
  };
}

const passingRunner: GateRunner = async () => ({ code: 0, stdout: '', stderr: '', timedOut: false });

describe('validateWorkerOutput', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'aisup-validation-'));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('passing gates → worker.validated, {passed:true}', async () => {
    const { journal, events } = spyJournal();
    const res = await validateWorkerOutput({
      gates: [gate({ name: 'unit' })],
      worktree: tmpDir,
      workerHome: join(tmpDir, '.home'),
      envAllowlist: ['PATH'],
      journal,
      taskId: 'task-A',
      allowNoValidation: false,
      runner: passingRunner,
    });
    expect(res.passed).toBe(true);
    expect(res.failed_gates).toEqual([]);
    expect(events.some((e) => e.event_type === 'worker.validated')).toBe(true);
  });

  it('a failing required gate → worker.validation_failed with the gate name, {passed:false}', async () => {
    const { journal, events } = spyJournal();
    const failingRunner: GateRunner = async () => ({ code: 1, stdout: '', stderr: 'boom', timedOut: false });
    const res = await validateWorkerOutput({
      gates: [gate({ name: 'unit', required: true })],
      worktree: tmpDir,
      workerHome: join(tmpDir, '.home'),
      envAllowlist: ['PATH'],
      journal,
      taskId: 'task-B',
      allowNoValidation: false,
      runner: failingRunner,
    });
    expect(res.passed).toBe(false);
    expect(res.failed_gates).toContain('unit');
    const failEvent = events.find((e) => e.event_type === 'worker.validation_failed');
    expect(failEvent?.details.failed_gates).toContain('unit');
  });

  it('no required gate + allow_no_validation:false → no_gates_configured, {passed:false}, runGates NOT called', async () => {
    const { journal, events } = spyJournal();
    let runnerCalled = false;
    const trapRunner: GateRunner = async () => {
      runnerCalled = true;
      return { code: 0, stdout: '', stderr: '', timedOut: false };
    };
    const res = await validateWorkerOutput({
      gates: [gate({ name: 'optional', required: false })], // optional-only
      worktree: tmpDir,
      workerHome: join(tmpDir, '.home'),
      envAllowlist: ['PATH'],
      journal,
      taskId: 'task-C',
      allowNoValidation: false,
      runner: trapRunner,
    });
    expect(res.passed).toBe(false);
    expect(runnerCalled).toBe(false); // short-circuited — no gate ran
    const ev = events.find((e) => e.event_type === 'worker.validation_failed');
    expect(ev?.details.reason).toBe('no_gates_configured');
  });

  it('every gate.* event carries worker_task_id; two runs stay attributable to distinct ids', async () => {
    const { journal, events } = spyJournal();
    await validateWorkerOutput({
      gates: [gate({ name: 'g1' })], worktree: tmpDir, workerHome: join(tmpDir, '.home'),
      envAllowlist: ['PATH'], journal, taskId: 'id-1', allowNoValidation: false, runner: passingRunner,
    });
    await validateWorkerOutput({
      gates: [gate({ name: 'g2' })], worktree: tmpDir, workerHome: join(tmpDir, '.home'),
      envAllowlist: ['PATH'], journal, taskId: 'id-2', allowNoValidation: false, runner: passingRunner,
    });
    const gateEvents = events.filter((e) => e.event_type.startsWith('gate.'));
    expect(gateEvents.length).toBeGreaterThan(0);
    expect(gateEvents.every((e) => e.details.worker_task_id === 'id-1' || e.details.worker_task_id === 'id-2')).toBe(true);
    expect(gateEvents.some((e) => e.details.worker_task_id === 'id-1')).toBe(true);
    expect(gateEvents.some((e) => e.details.worker_task_id === 'id-2')).toBe(true);
  });

  it('normalizes a gate-set cwd to the worktree (HI-001) — captured via an injected runner', async () => {
    const { journal } = spyJournal();
    const seen: (string | undefined)[] = [];
    const captureRunner: GateRunner = async (_c, _a, opts) => {
      seen.push(opts.cwd);
      return { code: 0, stdout: '', stderr: '', timedOut: false };
    };
    await validateWorkerOutput({
      gates: [gate({ name: 'g', cwd: '/some/other/path' })],
      worktree: tmpDir,
      workerHome: join(tmpDir, '.home'),
      envAllowlist: ['PATH'],
      journal,
      taskId: 'task-cwd',
      allowNoValidation: false,
      runner: captureRunner,
    });
    expect(seen[0]).toBe(tmpDir); // gate.cwd ignored; defaultCwd=worktree wins
  });

  it('a validation gate sees the isolated HOME, not the daemon real home (HI-005) — real runner', async () => {
    const { journal, events } = spyJournal();
    const workerHome = join(tmpDir, '.home');
    mkdirSync(workerHome, { recursive: true });
    await validateWorkerOutput({
      gates: [gate({ name: 'printhome', command: 'node', args: ['-e', 'process.stdout.write(process.env.HOME)'] })],
      worktree: tmpDir,
      workerHome,
      envAllowlist: ['PATH'],
      journal,
      taskId: 'task-home',
      allowNoValidation: false,
      // no injected runner → uses the real env-isolated worker gate runner
    });
    const gatePassed = events.find((e) => e.event_type === 'gate.passed');
    expect(gatePassed?.details.stdout_tail).toBe(workerHome);
  });

  it('a node gate resolves a dependency from the parent repo node_modules (MD-005) — real runner', async () => {
    // workspaceRoot with node_modules/mypkg; "worktree" is a nested subdir
    const pkgDir = join(tmpDir, 'node_modules', 'mypkg');
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: 'mypkg', version: '1.0.0', main: 'index.js' }));
    writeFileSync(join(pkgDir, 'index.js'), 'module.exports = 42;');
    const nested = join(tmpDir, 'nested');
    mkdirSync(nested, { recursive: true });
    const workerHome = join(nested, '.home');
    mkdirSync(workerHome, { recursive: true });
    const { journal } = spyJournal();
    const res = await validateWorkerOutput({
      gates: [gate({
        name: 'deps',
        command: 'node',
        args: ['-e', "if(require('mypkg')!==42)process.exit(3);process.stdout.write('ok')"],
      })],
      worktree: nested,
      workerHome,
      envAllowlist: ['PATH'],
      journal,
      taskId: 'task-deps',
      allowNoValidation: false,
    });
    expect(res.passed).toBe(true); // upward node_modules resolution worked
  });
});
