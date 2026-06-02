import { describe, it, expect, vi } from 'vitest';
import { runGates, GATE_OUTPUT_TAIL_LIMIT } from '../../src/gates/engine.js';
import type { GateRunner } from '../../src/gates/types.js';
import type { GateCommandConfig } from '../../src/config/schema.js';

const gate = (over: Partial<GateCommandConfig> = {}): GateCommandConfig => ({
  name: 'typecheck',
  command: 'npx',
  args: ['tsc', '--noEmit'],
  timeout_seconds: 30,
  required: true,
  cwd: null,
  ...over,
});

const passRunner: GateRunner = () => Promise.resolve({ code: 0, stdout: 'ok', stderr: '', timedOut: false });
const journalSpy = () => ({ append: vi.fn().mockResolvedValue(undefined) });
const eventTypes = (j: { append: ReturnType<typeof vi.fn> }): string[] =>
  j.append.mock.calls.map((c) => (c[0] as { event_type: string }).event_type);

describe('runGates', () => {
  it('passes when all gates exit 0 and emits started/passed/run_completed', async () => {
    const journal = journalSpy();
    const res = await runGates([gate()], { journal: journal as never, runner: passRunner });
    expect(res.passed).toBe(true);
    expect(res.results[0].status).toBe('passed');
    expect(eventTypes(journal)).toEqual(['gate.started', 'gate.passed', 'gate.run_completed']);
  });

  it('fails the run when a required gate exits non-zero', async () => {
    const journal = journalSpy();
    const runner: GateRunner = () => Promise.resolve({ code: 1, stdout: '', stderr: 'boom', timedOut: false });
    const res = await runGates([gate({ required: true })], { journal: journal as never, runner });
    expect(res.passed).toBe(false);
    expect(res.results[0].status).toBe('failed');
    expect(eventTypes(journal)).toContain('gate.failed');
  });

  it('does not fail the run when an optional gate fails', async () => {
    const journal = journalSpy();
    const runner: GateRunner = () => Promise.resolve({ code: 2, stdout: '', stderr: 'warn', timedOut: false });
    const res = await runGates([gate({ required: false })], { journal: journal as never, runner });
    expect(res.passed).toBe(true);
    expect(res.results[0].status).toBe('failed');
  });

  it('records a timeout as a distinct status and emits gate.timeout', async () => {
    const journal = journalSpy();
    const runner: GateRunner = () => Promise.resolve({ code: null, stdout: '', stderr: '', timedOut: true });
    const res = await runGates([gate()], { journal: journal as never, runner });
    expect(res.results[0].status).toBe('timeout');
    expect(res.passed).toBe(false);
    expect(eventTypes(journal)).toContain('gate.timeout');
  });

  it('runs multiple gates sequentially and reports each result in order', async () => {
    const journal = journalSpy();
    const calls: string[] = [];
    const runner: GateRunner = (command, args) => {
      calls.push(`${command} ${args.join(' ')}`);
      return Promise.resolve({ code: command === 'fail' ? 1 : 0, stdout: '', stderr: '', timedOut: false });
    };
    const res = await runGates(
      [gate({ name: 'a', command: 'ok', args: [] }), gate({ name: 'b', command: 'fail', args: [], required: false })],
      { journal: journal as never, runner }
    );
    expect(calls).toEqual(['ok ', 'fail ']);
    expect(res.results.map((r) => r.name)).toEqual(['a', 'b']);
    expect(res.results.map((r) => r.status)).toEqual(['passed', 'failed']);
  });

  it('truncates captured stdout/stderr to the tail limit', async () => {
    const journal = journalSpy();
    const big = 'x'.repeat(GATE_OUTPUT_TAIL_LIMIT + 500) + 'END';
    const runner: GateRunner = () => Promise.resolve({ code: 0, stdout: big, stderr: '', timedOut: false });
    const res = await runGates([gate()], { journal: journal as never, runner });
    expect(res.results[0].stdoutTail.length).toBe(GATE_OUTPUT_TAIL_LIMIT);
    expect(res.results[0].stdoutTail.endsWith('END')).toBe(true); // keeps the tail, not the head
  });

  it('marks a missing executable as failed and keeps going (no crash)', async () => {
    const journal = journalSpy();
    const res = await runGates(
      [gate({ name: 'missing', command: 'definitely-not-a-real-binary-xyz', args: [], required: false }), gate({ name: 'after', command: 'ok', args: [] })],
      { journal: journal as never, runner: undefined } // real default runner
    );
    expect(res.results[0].status).toBe('failed'); // ENOENT
    expect(res.results.map((r) => r.name)).toEqual(['missing', 'after']);
  });

  it('executes the real binary shell-free: args are passed literally, not interpreted', async () => {
    const journal = journalSpy();
    // If args were shell-interpreted, "; echo HACKED" would run; execFile passes them literally.
    const res = await runGates(
      [gate({ name: 'echo', command: 'node', args: ['-e', 'process.stdout.write("safe ; echo HACKED")'], timeout_seconds: 30 })],
      { journal: journal as never }
    );
    expect(res.passed).toBe(true);
    expect(res.results[0].status).toBe('passed');
    expect(res.results[0].stdoutTail).toBe('safe ; echo HACKED'); // the metachars are literal output
  });
});
