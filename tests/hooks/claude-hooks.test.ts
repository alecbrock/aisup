import { describe, it, expect } from 'vitest';
import { buildHookSettings } from '../../src/hooks/claude-hooks.js';

describe('buildHookSettings', () => {
  it('installs the skill hook pointed at /api/hooks/skill with the bearer token', () => {
    const s = buildHookSettings({ port: 7394, token: 'tok123', includeSkill: true, includePermission: false });
    const grp = s.hooks.UserPromptExpansion;
    expect(grp).toHaveLength(1);
    expect(grp[0].matcher).toBe('*');
    expect(grp[0].hooks[0]).toMatchObject({
      type: 'http',
      url: 'http://127.0.0.1:7394/api/hooks/skill',
      headers: { Authorization: 'Bearer tok123' },
    });
    // skill-only must not install the permission hook
    expect(s.hooks.PermissionRequest).toBeUndefined();
  });

  it('installs the permission hook with a long timeout for the human Slack decision', () => {
    const s = buildHookSettings({ port: 9000, token: 't', includeSkill: false, includePermission: true, permissionTimeoutS: 300 });
    const h = s.hooks.PermissionRequest[0].hooks[0];
    expect(h.url).toBe('http://127.0.0.1:9000/api/hooks/permission');
    expect(h.timeout).toBe(300);
    expect(s.hooks.UserPromptExpansion).toBeUndefined();
  });

  it('defaults the permission hook timeout to 30s (matches the daemon, AF-310)', () => {
    const s = buildHookSettings({ port: 9000, token: 't', includeSkill: false, includePermission: true });
    expect(s.hooks.PermissionRequest[0].hooks[0].timeout).toBe(30);
  });

  it('honors a custom host and installs both hooks when requested', () => {
    const s = buildHookSettings({ port: 1, token: 't', host: 'localhost', includeSkill: true, includePermission: true });
    expect(s.hooks.UserPromptExpansion[0].hooks[0].url).toBe('http://localhost:1/api/hooks/skill');
    expect(s.hooks.PermissionRequest[0].hooks[0].url).toBe('http://localhost:1/api/hooks/permission');
  });
});
