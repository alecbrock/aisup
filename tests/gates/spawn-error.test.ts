import { describe, it, expect } from 'vitest';
import { runGates } from '../../src/gates/engine.js';
import type { GateCommandConfig } from '../../src/config/schema.js';
import type { JournalEvent } from '../../src/journal/types.js';

/** F-6: a gate whose command binary does not exist (ENOENT) must record the spawn error in
 *  stderr_tail on gate.failed, not a silent exit_code:null with empty output. */
describe('F-6 gate spawn error surfaced', () => {
  it('captures the ENOENT spawn error in the gate.failed stderr_tail', async () => {
    const events: JournalEvent[] = [];
    const gate: GateCommandConfig = {
      name: 'missing-binary', command: 'aisup-nonexistent-binary-xyz', args: [],
      timeout_seconds: 10, required: true, cwd: null,
    };
    const result = await runGates([gate], { journal: { append: async (e) => { events.push(e); } } });

    expect(result.passed).toBe(false);
    const failed = events.find((e) => e.event_type === 'gate.failed');
    expect(failed).toBeDefined();
    expect(String(failed?.details.stderr_tail)).toMatch(/spawn error|ENOENT/i);
  });
});
