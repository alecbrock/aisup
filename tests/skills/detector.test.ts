import { describe, it, expect } from 'vitest';
import { detectSkill } from '../../src/skills/detector.js';

const TRACKED = ['/prd', '/spec', '/fix', '/review', '/security-review'];

describe('detectSkill', () => {
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
