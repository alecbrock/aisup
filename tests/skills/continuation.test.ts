import { describe, it, expect } from 'vitest';
import { buildContinuationPrompt } from '../../src/skills/continuation.js';

describe('buildContinuationPrompt', () => {
  it('names both the skill and the plan when both are known', () => {
    const p = buildContinuationPrompt({ activeSkill: '/spec', planPath: '/tmp/PLAN.md' });
    expect(p).toContain('/spec');
    expect(p).toContain('/tmp/PLAN.md');
    expect(p).toContain('Resume from the next uncompleted task');
  });

  it('names only the skill when there is no plan (no "Plan file: not specified")', () => {
    const p = buildContinuationPrompt({ activeSkill: '/fix', planPath: null });
    expect(p).toContain('/fix');
    expect(p).not.toMatch(/not specified/i);
    expect(p).not.toMatch(/plan file/i);
  });

  it('names only the plan when there is no skill (no "unknown skill")', () => {
    const p = buildContinuationPrompt({ activeSkill: null, planPath: '/tmp/PLAN.md' });
    expect(p).toContain('/tmp/PLAN.md');
    expect(p).not.toMatch(/unknown skill/i);
  });

  it('still produces a usable prompt when neither is known', () => {
    const p = buildContinuationPrompt({ activeSkill: null, planPath: null });
    expect(p).toContain('Continue the current session');
    expect(p).not.toMatch(/unknown skill|not specified/i);
  });

  it('honors a custom template with placeholder replacement', () => {
    const p = buildContinuationPrompt({
      activeSkill: '/spec',
      planPath: '/tmp/PLAN.md',
      template: 'Resume {skill} using {plan_path}.',
    });
    expect(p).toBe('Resume /spec using /tmp/PLAN.md.');
  });
});
