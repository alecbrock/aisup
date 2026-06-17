import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runWorker } from '../../src/workers/runner.js';
import type { WorkerExec } from '../../src/workers/runner.js';
import type { WorkerLaunchPlan } from '../../src/workers/adapter.js';
import { GATE_OUTPUT_TAIL_LIMIT } from '../../src/gates/engine.js';

const baseEnv = (): Record<string, string> => ({ PATH: process.env.PATH ?? '', HOME: '/tmp/fake-home' });

describe('runWorker', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'aisup-runner-'));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('runs shell-free, captures stdout, and honours cwd', async () => {
    const plan: WorkerLaunchPlan = {
      command: 'node',
      args: ['-e', 'process.stdout.write(process.cwd())'],
      env: baseEnv(),
      stdin: null,
      promptFile: null,
    };
    const res = await runWorker(plan, { cwd: tmpDir, timeoutSeconds: 30 });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain(tmpDir.split('/').pop()!);
    expect(res.timedOut).toBe(false);
  });

  it('marks timedOut:true with code:null when the command exceeds the timeout', async () => {
    const plan: WorkerLaunchPlan = {
      command: 'node',
      args: ['-e', 'setTimeout(() => {}, 5000)'],
      env: baseEnv(),
      stdin: null,
      promptFile: null,
    };
    const res = await runWorker(plan, { cwd: tmpDir, timeoutSeconds: 1 });
    expect(res.timedOut).toBe(true);
    expect(res.code).toBeNull();
  });

  it('delivers stdin to the child', async () => {
    const plan: WorkerLaunchPlan = {
      command: 'node',
      args: ['-e', 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>process.stdout.write("GOT:"+d))'],
      env: baseEnv(),
      stdin: 'hello-stdin',
      promptFile: null,
    };
    const res = await runWorker(plan, { cwd: tmpDir, timeoutSeconds: 30 });
    expect(res.stdout).toBe('GOT:hello-stdin');
  });

  it('truncates stdout to the tail limit', async () => {
    const n = GATE_OUTPUT_TAIL_LIMIT + 500;
    const plan: WorkerLaunchPlan = {
      command: 'node',
      args: ['-e', `process.stdout.write("x".repeat(${n}))`],
      env: baseEnv(),
      stdin: null,
      promptFile: null,
    };
    const res = await runWorker(plan, { cwd: tmpDir, timeoutSeconds: 30 });
    expect(res.stdout.length).toBe(GATE_OUTPUT_TAIL_LIMIT);
  });

  it('passes shell metacharacters literally (no expansion) — proves shell-free', async () => {
    const evil = '$(touch pwned); `echo hi`; rm -rf /';
    const plan: WorkerLaunchPlan = {
      command: 'node',
      args: ['-e', 'process.stdout.write(process.argv[1])', evil],
      env: baseEnv(),
      stdin: null,
      promptFile: null,
    };
    const res = await runWorker(plan, { cwd: tmpDir, timeoutSeconds: 30 });
    expect(res.stdout).toBe(evil);
    expect(existsSync(join(tmpDir, 'pwned'))).toBe(false);
  });

  it('writes the prompt file (under the state dir) before the child runs and removes it after', async () => {
    const promptPath = join(tmpDir, 'state', 'prompt.txt');
    const plan: WorkerLaunchPlan = {
      command: 'node',
      args: ['-e', `process.stdout.write(require('fs').readFileSync(process.argv[1],'utf8'))`, promptPath],
      env: baseEnv(),
      stdin: null,
      promptFile: { path: promptPath, contents: 'the-prompt-contents' },
    };
    const res = await runWorker(plan, { cwd: tmpDir, timeoutSeconds: 30 });
    expect(res.stdout).toBe('the-prompt-contents'); // file present during the run
    expect(existsSync(promptPath)).toBe(false); // removed after
  });

  it('removes the prompt file even when the child times out', async () => {
    const promptPath = join(tmpDir, 'state', 'prompt.txt');
    const plan: WorkerLaunchPlan = {
      command: 'node',
      args: ['-e', 'setTimeout(()=>{},5000)', promptPath],
      env: baseEnv(),
      stdin: null,
      promptFile: { path: promptPath, contents: 'x' },
    };
    const res = await runWorker(plan, { cwd: tmpDir, timeoutSeconds: 1 });
    expect(res.timedOut).toBe(true);
    expect(existsSync(promptPath)).toBe(false);
  });

  it('uses an injectable exec to assert command/args/stdin without spawning', async () => {
    const calls: { command: string; args: string[]; stdin: string | null }[] = [];
    const fakeExec: WorkerExec = async (command, args, opts) => {
      calls.push({ command, args, stdin: opts.stdin });
      return { code: 0, stdout: 'ok', stderr: '', timedOut: false };
    };
    const plan: WorkerLaunchPlan = {
      command: 'codex',
      args: ['run', 'do it'],
      env: baseEnv(),
      stdin: 'piped',
      promptFile: null,
    };
    const res = await runWorker(plan, { cwd: tmpDir, timeoutSeconds: 30, exec: fakeExec });
    expect(res.stdout).toBe('ok');
    expect(calls[0].command).toBe('codex');
    expect(calls[0].args).toEqual(['run', 'do it']);
    expect(calls[0].stdin).toBe('piped');
  });
});
