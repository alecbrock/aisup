import { describe, it, expect } from 'vitest';
import { SkillTracker } from '../../src/skills/tracker.js';

const TRACKED = ['/prd', '/spec', '/fix', '/review', '/security-review'];

describe('SkillTracker', () => {
  it('should start with no active skill', () => {
    const tracker = new SkillTracker(TRACKED);
    expect(tracker.activeSkill).toBeNull();
  });

  it('should detect and set active skill from output', () => {
    const tracker = new SkillTracker(TRACKED);
    tracker.processOutput('Launching skill: spec-plan');
    expect(tracker.activeSkill).toBe('/spec');
  });

  it('should transition to latest skill (latest wins)', () => {
    const tracker = new SkillTracker(TRACKED);
    tracker.processOutput('Launching skill: prd');
    tracker.processOutput('Launching skill: spec');
    expect(tracker.activeSkill).toBe('/spec');
  });

  it('should not change skill for untracked output', () => {
    const tracker = new SkillTracker(TRACKED);
    tracker.processOutput('Launching skill: spec');
    tracker.processOutput('Launching skill: brainstorm');
    expect(tracker.activeSkill).toBe('/spec');
  });

  it('should emit transition events', () => {
    const transitions: Array<{ from: string | null; to: string }> = [];
    const tracker = new SkillTracker(TRACKED, (from, to) => transitions.push({ from, to }));
    tracker.processOutput('Launching skill: prd');
    tracker.processOutput('Launching skill: spec');
    expect(transitions).toHaveLength(2);
    expect(transitions[0]).toEqual({ from: null, to: '/prd' });
    expect(transitions[1]).toEqual({ from: '/prd', to: '/spec' });
  });

  it('should allow resetting active skill', () => {
    const tracker = new SkillTracker(TRACKED);
    tracker.processOutput('Launching skill: spec');
    tracker.reset();
    expect(tracker.activeSkill).toBeNull();
  });
});
