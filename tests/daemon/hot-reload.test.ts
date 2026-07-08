import { describe, it, expect } from 'vitest';
import { planReload } from '../../src/daemon/reload.js';
import type { AisupConfig } from '../../src/config/schema.js';

const base = (): AisupConfig => ({
  accounts: [{ name: 'primary', config_dir: '/c/p', priority: 1, enabled: true }],
  thresholds: { soft_pct: 85, hard_pct: 95, idle_boundary_seconds: 30 },
  monitoring: { rate_limit_interval_s: 30, health_interval_s: 60, recovery_interval_s: 5, idle_interval_s: 120 },
  notifications: { verbosity: 'normal' },
  slack: { enabled: true, allowed_user_ids: ['U1'] },
  daemon: { port: 7394 },
  journal: { path: '~/.aisup/journal.jsonl' },
  statusline: { directory: '/tmp/tap' },
} as unknown as AisupConfig);

describe('C13: hot-reload plan', () => {
  it('applies threshold changes live', () => {
    const next = base(); next.thresholds.soft_pct = 70;
    const plan = planReload(base(), next);
    expect(plan.applied).toContain('thresholds.soft_pct');
    expect(plan.restart_required).toHaveLength(0);
  });

  it('applies verbosity, allowed-users, and account changes live', () => {
    const next = base();
    next.notifications.verbosity = 'verbose';
    next.slack.allowed_user_ids = ['U1', 'U2'];
    next.accounts = [...next.accounts, { name: 'account2', config_dir: '/c/2', priority: 2, enabled: true }] as AisupConfig['accounts'];
    const plan = planReload(base(), next);
    expect(plan.applied).toEqual(expect.arrayContaining(['notifications.verbosity', 'slack.allowed_user_ids', 'accounts']));
    expect(plan.restart_required).toHaveLength(0);
  });

  it('flags structural changes (port, journal path, intervals) as restart-required, not applied', () => {
    const next = base();
    next.daemon.port = 8000;
    next.journal.path = '/other/journal.jsonl';
    next.monitoring.rate_limit_interval_s = 10;
    const plan = planReload(base(), next);
    expect(plan.restart_required).toEqual(expect.arrayContaining(['daemon.port', 'journal.path', 'monitoring']));
    expect(plan.applied).toHaveLength(0);
  });

  it('reports nothing when config is unchanged', () => {
    const plan = planReload(base(), base());
    expect(plan.applied).toHaveLength(0);
    expect(plan.restart_required).toHaveLength(0);
  });
});
