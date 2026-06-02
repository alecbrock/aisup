import { describe, it, expect } from 'vitest';
import { evaluatePermission } from '../../src/permissions/policy.js';
import type { PermissionPolicyConfig } from '../../src/config/schema.js';
import type { PermissionRequest } from '../../src/permissions/types.js';

const req = (tool: string, detail: string): PermissionRequest => ({ tool, detail, raw: `${tool}: ${detail}` });

const policy = (over: Partial<PermissionPolicyConfig> = {}): PermissionPolicyConfig => ({
  allowlist: [],
  denylist: [],
  default_action: 'deny',
  ...over,
});

describe('evaluatePermission', () => {
  it('grants an allowlisted request', () => {
    expect(evaluatePermission(req('Read', 'config.json'), policy({ allowlist: ['Read:*'] }))).toBe('grant');
  });

  it('denies a denylisted request', () => {
    expect(evaluatePermission(req('Bash', 'rm -rf build'), policy({ denylist: ['Bash:rm *'] }))).toBe('deny');
  });

  it('lets the denylist win over the allowlist', () => {
    const p = policy({ allowlist: ['Bash:*'], denylist: ['Bash:git push*'] });
    expect(evaluatePermission(req('Bash', 'git push origin main'), p)).toBe('deny');
  });

  it('falls back to "ask" for an unmatched request when default_action is deny', () => {
    expect(evaluatePermission(req('WebFetch', 'https://x'), policy({ default_action: 'deny' }))).toBe('ask');
  });

  it('falls back to "grant" for an unmatched request when default_action is allow', () => {
    expect(evaluatePermission(req('WebFetch', 'https://x'), policy({ default_action: 'allow' }))).toBe('grant');
  });

  it('matches "Bash:git *" globs by command prefix only', () => {
    const p = policy({ allowlist: ['Bash:git *'], default_action: 'deny' });
    expect(evaluatePermission(req('Bash', 'git status'), p)).toBe('grant');
    expect(evaluatePermission(req('Bash', 'rm -rf /'), p)).toBe('ask'); // unmatched → default
  });

  it('matches path-style "**" globs across path separators', () => {
    const p = policy({ allowlist: ['Read:/home/**'], default_action: 'deny' });
    expect(evaluatePermission(req('Read', '/home/user/project/file.ts'), p)).toBe('grant');
    expect(evaluatePermission(req('Read', '/etc/passwd'), p)).toBe('ask'); // outside /home → default
  });

  it('does not crash on a malformed glob in the policy config', () => {
    const p = policy({ denylist: ['['], allowlist: ['Read:*'], default_action: 'deny' });
    expect(() => evaluatePermission(req('Read', 'x'), p)).not.toThrow();
    expect(evaluatePermission(req('Read', 'x'), p)).toBe('grant'); // bad denylist glob ignored, allowlist matches
  });
});
