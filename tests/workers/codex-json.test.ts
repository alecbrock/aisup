import { describe, it, expect } from 'vitest';
import { parseCodexJsonStream, chargeableTokens } from '../../src/workers/codex-json.js';

// Real `codex exec --json` capture (codex-cli 0.140.0, 2026-06-19).
const REAL_FIXTURE = [
  '{"type":"thread.started","thread_id":"019ee0ef-5332-71b1-bb04-e1c6dcf3899c"}',
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"reasoning","text":"**Providing exact response**"}}',
  '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"PONG"}}',
  '{"type":"turn.completed","usage":{"input_tokens":39058,"cached_input_tokens":2432,"output_tokens":35,"reasoning_output_tokens":27}}',
].join('\n');

describe('parseCodexJsonStream', () => {
  it('extracts the final agent_message text and usage from a real codex --json stream', () => {
    const r = parseCodexJsonStream(REAL_FIXTURE);
    expect(r.finalText).toBe('PONG');
    expect(r.usage).toEqual({ input_tokens: 39058, cached_input_tokens: 2432, output_tokens: 35, reasoning_output_tokens: 27 });
  });

  it('charges input + output tokens against the budget (cached/reasoning excluded)', () => {
    const r = parseCodexJsonStream(REAL_FIXTURE);
    expect(chargeableTokens(r.usage!)).toBe(39058 + 35);
  });

  it('returns null usage and empty text for a stream with no agent_message/turn.completed', () => {
    const r = parseCodexJsonStream('{"type":"turn.started"}\n');
    expect(r.usage).toBeNull();
    expect(r.finalText).toBe('');
  });

  it('tolerates interleaved reasoning lines and keeps the last agent_message', () => {
    const s = [
      '{"type":"item.completed","item":{"type":"agent_message","text":"first"}}',
      '{"type":"item.completed","item":{"type":"reasoning","text":"thinking"}}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"VERDICT: APPROVE"}}',
    ].join('\n');
    expect(parseCodexJsonStream(s).finalText).toBe('VERDICT: APPROVE');
  });

  it('skips malformed (non-JSON) lines without throwing', () => {
    const s = 'not json\n{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}\ngarbage';
    expect(parseCodexJsonStream(s).finalText).toBe('ok');
  });
});
