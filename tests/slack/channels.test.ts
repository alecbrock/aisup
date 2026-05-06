import { describe, it, expect } from 'vitest';
import { slugifyProjectName, buildChannelName } from '../../src/slack/channels.js';

describe('slugifyProjectName', () => {
  it('should lowercase and replace spaces with hyphens', () => {
    expect(slugifyProjectName('My Project')).toBe('my-project');
  });

  it('should handle uppercase', () => {
    expect(slugifyProjectName('FooBar')).toBe('foobar');
  });

  it('should replace punctuation with hyphens', () => {
    expect(slugifyProjectName('foo/bar.baz')).toBe('foo-bar-baz');
  });

  it('should collapse consecutive hyphens', () => {
    expect(slugifyProjectName('foo--bar___baz')).toBe('foo-bar-baz');
  });

  it('should strip leading and trailing hyphens', () => {
    expect(slugifyProjectName('--foo--')).toBe('foo');
  });

  it('should handle empty string', () => {
    expect(slugifyProjectName('')).toBe('project');
  });

  it('should truncate long names to fit within max length', () => {
    const long = 'a'.repeat(100);
    const slug = slugifyProjectName(long);
    expect(slug.length).toBeLessThanOrEqual(50);
  });

  it('should handle names with only special chars', () => {
    const result = slugifyProjectName('!!!');
    expect(result).toBeTruthy();
    expect(result.length).toBeGreaterThan(0);
  });
});

describe('buildChannelName', () => {
  it('should construct channel name with project slug and session id prefix', () => {
    const name = buildChannelName('my-project', 'abc12345-def0-1234-5678-000000000000');
    expect(name).toMatch(/^aisup-my-project-abc12345/);
  });

  it('should be at most 80 characters', () => {
    const longProject = 'a'.repeat(60);
    const name = buildChannelName(longProject, 'abc12345-def0-1234-5678-000000000000');
    expect(name.length).toBeLessThanOrEqual(80);
  });

  it('should use first 8 chars of session id', () => {
    const name = buildChannelName('proj', 'abcdefff-0000-0000-0000-000000000000');
    expect(name).toContain('abcdefff');
  });
});
