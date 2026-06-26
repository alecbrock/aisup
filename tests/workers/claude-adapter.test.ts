import { describe, it, expect } from 'vitest';
import { homedir } from 'node:os';
import { buildClaudeWorkerCommand, parseClaudeResult } from '../../src/workers/claude-adapter.js';

describe('buildClaudeWorkerCommand', () => {
  const base = {
    account: { name: 'acct1', config_dir: '/home/u/.claude-acct1' },
    prompt: 'do the thing',
    worktreePath: '/tmp/wt',
    envAllowlist: ['PATH'],
  };

  it('builds a claude -p --output-format json plan with the prompt as the final positional', () => {
    const plan = buildClaudeWorkerCommand(base);
    expect(plan.command).toBe('claude');
    expect(plan.args).toContain('-p');
    const ofi = plan.args.indexOf('--output-format');
    expect(ofi).toBeGreaterThanOrEqual(0);
    expect(plan.args[ofi + 1]).toBe('json');
    expect(plan.args[plan.args.length - 1]).toBe('do the thing');
    expect(plan.stdin).toBeNull();
  });

  it('uses a non-interactive bypass permission mode by default', () => {
    const plan = buildClaudeWorkerCommand(base);
    const i = plan.args.indexOf('--permission-mode');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(plan.args[i + 1]).toBe('bypassPermissions');
  });

  it('injects the account CLAUDE_CONFIG_DIR and uses the real HOME for keychain OAuth (Option C)', () => {
    const plan = buildClaudeWorkerCommand(base);
    expect(plan.env.CLAUDE_CONFIG_DIR).toBe('/home/u/.claude-acct1');
    expect(plan.env.HOME).toBe(homedir()); // real HOME — keychain auth needs it (NOT the worktree .home)
    expect(plan.env.PATH).toBe(process.env.PATH);
  });

  it('adds --model only when a model is provided', () => {
    expect(buildClaudeWorkerCommand(base).args).not.toContain('--model');
    const withModel = buildClaudeWorkerCommand({ ...base, model: 'claude-opus-4-8' });
    const i = withModel.args.indexOf('--model');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(withModel.args[i + 1]).toBe('claude-opus-4-8');
  });
});

describe('parseClaudeResult', () => {
  // Shape per `## Assumptions` (real `claude -p --output-format json` capture, 2026-06-19):
  // a JSON array of stream events whose final {type:'result'} carries result text + usage + total_cost_usd.
  const arrayFixture = JSON.stringify([
    { type: 'system', subtype: 'init' },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'working' }] } },
    {
      type: 'result',
      subtype: 'success',
      result: 'done editing files',
      total_cost_usd: 0.0123,
      usage: { input_tokens: 1200, output_tokens: 345, cache_creation_input_tokens: 0, cache_read_input_tokens: 100 },
    },
  ]);

  it('extracts result text and input/output token usage from the final result element', () => {
    const r = parseClaudeResult(arrayFixture);
    expect(r.result).toBe('done editing files');
    expect(r.usage).toEqual({ input_tokens: 1200, output_tokens: 345 });
    expect(r.total_cost_usd).toBe(0.0123);
  });

  it('parses a single result object (non-array) shape too', () => {
    const single = JSON.stringify({
      type: 'result',
      subtype: 'success',
      result: 'ok',
      usage: { input_tokens: 5, output_tokens: 7 },
      total_cost_usd: 0.001,
    });
    const r = parseClaudeResult(single);
    expect(r.result).toBe('ok');
    expect(r.usage).toEqual({ input_tokens: 5, output_tokens: 7 });
  });

  it('returns empty result and null usage on unparseable output (fail-soft)', () => {
    const r = parseClaudeResult('not json at all');
    expect(r.result).toBe('');
    expect(r.usage).toBeNull();
    expect(r.total_cost_usd).toBeNull();
  });
});
