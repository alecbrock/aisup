import { describe, it, expect } from 'vitest';
import { formatGateRun } from '../../src/cli/commands/gate.js';
import type { GateRunResult } from '../../src/gates/types.js';

describe('formatGateRun', () => {
  it('summarizes a passing run with each gate, marking optional ones', () => {
    const result: GateRunResult = {
      passed: true,
      results: [
        { name: 'typecheck', status: 'passed', exitCode: 0, stdoutTail: '', stderrTail: '', required: true },
        { name: 'lint', status: 'failed', exitCode: 1, stdoutTail: '', stderrTail: 'x', required: false },
      ],
    };
    const out = formatGateRun(result);
    expect(out).toContain('Gates: PASSED');
    expect(out).toContain('PASSED typecheck');
    expect(out).toContain('FAILED lint (optional)');
  });

  it('marks an overall-failed run', () => {
    expect(formatGateRun({ passed: false, results: [] })).toContain('Gates: FAILED');
  });
});
