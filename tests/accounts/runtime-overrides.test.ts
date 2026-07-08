import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AccountRegistry } from '../../src/accounts/registry.js';
import { explainSelection } from '../../src/failover/switcher.js';
import { SwitchReason } from '../../src/failover/types.js';
import type { AisupConfig } from '../../src/config/schema.js';

const config = (): AisupConfig => ({
  accounts: [
    { name: 'primary', config_dir: '/c/p', priority: 1, enabled: true },
    { name: 'account2', config_dir: '/c/2', priority: 2, enabled: true },
    { name: 'account3', config_dir: '/c/3', priority: 3, enabled: true },
  ],
} as AisupConfig);

describe('C7: runtime account overrides', () => {
  let dir: string;
  let path: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'aisup-ovr-')); path = join(dir, 'account-overrides.json'); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('persists overrides to disk and reloads them into a fresh registry', () => {
    const r1 = new AccountRegistry(config(), path);
    r1.setOverride('account2', { excluded: true });
    expect(existsSync(path)).toBe(true);

    const r2 = new AccountRegistry(config(), path);
    expect(r2.get('account2')!.excluded).toBe(true);
  });

  it('--exclude removes an account from selection', () => {
    const r = new AccountRegistry(config(), path);
    r.setScore('account2', 90);
    r.setScore('account3', 50);
    r.setOverride('account2', { excluded: true });

    const { chosen, rationale } = explainSelection(r.getAll(), 'primary', [], { reason: SwitchReason.RateLimit429 });
    expect(chosen?.name).toBe('account3'); // account2 excluded despite the higher score
    expect(rationale.candidates.find((c) => c.name === 'account2')!.excluded_reason).toBe('excluded');
  });

  it('--pin forces a runnable account regardless of score', () => {
    const r = new AccountRegistry(config(), path);
    r.setScore('account2', 10);
    r.setScore('account3', 99);
    r.setOverride('account2', { pinned: true });

    const { chosen } = explainSelection(r.getAll(), 'primary', [], { reason: SwitchReason.RateLimit429 });
    expect(chosen?.name).toBe('account2'); // pinned wins over the higher-scored account3
  });

  it('does not force a pinned account that is UNAVAILABLE (safety over pin)', () => {
    const r = new AccountRegistry(config(), path);
    r.setScore('account3', 40);
    r.setOverride('account2', { pinned: true });
    r.setState('account2', 'UNAVAILABLE');

    const { chosen } = explainSelection(r.getAll(), 'primary', [], { reason: SwitchReason.RateLimit429 });
    expect(chosen?.name).toBe('account3'); // pinned account2 is unavailable → fall through
  });

  it('--disable clears via override and --clear resets everything', () => {
    const r = new AccountRegistry(config(), path);
    r.setOverride('account2', { enabled: false });
    expect(r.get('account2')!.enabled).toBe(false);

    r.clearOverrides();
    expect(r.get('account2')!.enabled).toBe(true);
    expect(r.get('account2')!.excluded).toBeFalsy();
  });
});
