import { describe, it, expect } from 'vitest';
import { detectSkill, resolveSkillFromCommandName } from '../../src/skills/detector.js';

const TRACKED = ['/prd', '/spec', '/fix', '/review', '/security-review'];

// AF-309/AF-323: the PRIMARY live skill path is the UserPromptExpansion hook → resolveSkillFromCommandName.
// These tests live with the function they cover (moved here from tests/hooks/claude-hooks.test.ts) and
// exercise the real hook command names. detectSkill below is the pane-output fallback only.
describe('resolveSkillFromCommandName (live hook path)', () => {
  it('maps an exact command name to its tracked skill', () => {
    expect(resolveSkillFromCommandName('prd', TRACKED)).toBe('/prd');
  });

  it('maps a prefixed sub-command (spec-plan) to the parent skill', () => {
    expect(resolveSkillFromCommandName('spec-plan', TRACKED)).toBe('/spec');
    expect(resolveSkillFromCommandName('security-review', TRACKED)).toBe('/security-review');
  });

  it('tolerates a leading slash from the raw prompt', () => {
    expect(resolveSkillFromCommandName('/fix', TRACKED)).toBe('/fix');
  });

  it('returns null for untracked or unrelated commands', () => {
    expect(resolveSkillFromCommandName('clear', TRACKED)).toBeNull();
    expect(resolveSkillFromCommandName('prd', ['/spec'])).toBeNull();
  });
});

describe('detectSkill (pane-output fallback)', () => {
  it('should detect spec skill from "Launching skill: spec-plan"', () => {
    expect(detectSkill('Launching skill: spec-plan', TRACKED)).toBe('/spec');
  });

  it('should detect spec from "Launching skill: spec"', () => {
    expect(detectSkill('Launching skill: spec', TRACKED)).toBe('/spec');
  });

  it('should detect prd from "Launching skill: prd"', () => {
    expect(detectSkill('Launching skill: prd', TRACKED)).toBe('/prd');
  });

  it('should detect fix from "Launching skill: fix"', () => {
    expect(detectSkill('Launching skill: fix', TRACKED)).toBe('/fix');
  });

  it('should detect review', () => {
    expect(detectSkill('Launching skill: review', TRACKED)).toBe('/review');
  });

  it('should detect security-review', () => {
    expect(detectSkill('Launching skill: security-review', TRACKED)).toBe('/security-review');
  });

  it('should return null for untracked skills', () => {
    expect(detectSkill('Launching skill: test-driven-development', TRACKED)).toBeNull();
  });

  it('should return null for non-skill output', () => {
    expect(detectSkill('Task 3 completed successfully', TRACKED)).toBeNull();
  });

  it('should return null for empty string', () => {
    expect(detectSkill('', TRACKED)).toBeNull();
  });

  it('should detect skill in multi-line output', () => {
    const output = 'Some text\nLaunching skill: spec-implement\nMore text';
    expect(detectSkill(output, TRACKED)).toBe('/spec');
  });

  it('should map spec-implement and spec-verify to /spec', () => {
    expect(detectSkill('Launching skill: spec-implement', TRACKED)).toBe('/spec');
    expect(detectSkill('Launching skill: spec-verify', TRACKED)).toBe('/spec');
    expect(detectSkill('Launching skill: spec-bugfix-plan', TRACKED)).toBe('/spec');
  });
});
