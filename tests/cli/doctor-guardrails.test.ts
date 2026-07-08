import { describe, it, expect } from 'vitest';
import { checkAccountCount, checkSlackInteractivity } from '../../src/cli/commands/doctor.js';
import type { AisupConfig } from '../../src/config/schema.js';

const cfg = (over: Partial<AisupConfig>): AisupConfig => ({
  accounts: [],
  slack: { enabled: false, interactivity_enabled: true } as AisupConfig['slack'],
  ...over,
} as AisupConfig);

describe('C5: doctor guardrails', () => {
  it('flags fewer than 2 configured accounts (failover needs ≥2)', () => {
    const one = checkAccountCount(cfg({ accounts: [{ name: 'primary' }] as AisupConfig['accounts'] }));
    expect(one.ok).toBe(false);
    expect(one.detail).toMatch(/2/);

    const two = checkAccountCount(cfg({ accounts: [{ name: 'primary' }, { name: 'account2' }] as AisupConfig['accounts'] }));
    expect(two.ok).toBe(true);
  });

  it('skips the Slack interactivity check when Slack is disabled', () => {
    expect(checkSlackInteractivity(cfg({ slack: { enabled: false, interactivity_enabled: true } as AisupConfig['slack'] }))).toBeNull();
  });

  it('flags Slack interactivity when disabled in config', () => {
    const c = checkSlackInteractivity(cfg({ slack: { enabled: true, interactivity_enabled: false } as AisupConfig['slack'] }));
    expect(c).not.toBeNull();
    expect(c!.ok).toBe(false);
  });

  it('passes Slack interactivity (with app-toggle reminder) when enabled in config', () => {
    const c = checkSlackInteractivity(cfg({ slack: { enabled: true, interactivity_enabled: true } as AisupConfig['slack'] }));
    expect(c).not.toBeNull();
    expect(c!.ok).toBe(true);
    expect(c!.detail).toMatch(/interactivity/i);
  });
});
