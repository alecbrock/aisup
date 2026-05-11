import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SwitchReason } from '../../src/failover/types.js';
import { performSwitch, selectSwitchTarget, validateManualFailoverTarget } from '../../src/failover/switcher.js';
import type { AccountInfo } from '../../src/accounts/types.js';
import type { SessionState } from '../../src/session/types.js';

describe('validateManualFailoverTarget', () => {
  const makeAccounts = (overrides: Partial<AccountInfo>[] = []): AccountInfo[] => [
    {
      name: 'primary',
      configDir: '/home/.claude',
      priority: 1,
      enabled: true,
      state: 'ACTIVE' as AccountInfo['state'],
      score: 50,
      cooldownUntil: null,
      ...overrides[0],
    },
    {
      name: 'account2',
      configDir: '/home/.claude-account2',
      priority: 2,
      enabled: true,
      state: 'HEALTHY',
      score: 60,
      cooldownUntil: null,
      ...overrides[1],
    },
  ];

  it('should accept a valid HEALTHY target that is not current', () => {
    const result = validateManualFailoverTarget('account2', 'primary', makeAccounts());
    expect(result.valid).toBe(true);
  });

  it('should reject target not in config', () => {
    const result = validateManualFailoverTarget('unknown', 'primary', makeAccounts());
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/target_invalid|not found/i);
  });

  it('should reject when target is current account', () => {
    const result = validateManualFailoverTarget('primary', 'primary', makeAccounts());
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/target_is_current|already/i);
  });

  it('should reject disabled target', () => {
    const accounts = makeAccounts([{}, { enabled: false, state: 'HEALTHY' }]);
    const result = validateManualFailoverTarget('account2', 'primary', accounts);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/target_unavailable|disabled/i);
  });

  it('should reject UNAVAILABLE target', () => {
    const accounts = makeAccounts([{}, { state: 'UNAVAILABLE' }]);
    const result = validateManualFailoverTarget('account2', 'primary', accounts);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/target_unavailable/i);
  });

  it('should accept COOLDOWN target with a warning (manual override)', () => {
    const accounts = makeAccounts([{}, { state: 'COOLDOWN' }]);
    const result = validateManualFailoverTarget('account2', 'primary', accounts);
    expect(result.valid).toBe(true);
    expect(result.warning).toMatch(/cooldown/i);
  });

  it('should accept DEGRADED target', () => {
    const accounts = makeAccounts([{}, { state: 'DEGRADED' }]);
    const result = validateManualFailoverTarget('account2', 'primary', accounts);
    expect(result.valid).toBe(true);
  });
});

describe('SwitchReason enum values', () => {
  it('should define expected switch reasons', () => {
    expect(SwitchReason.SoftThreshold).toBeDefined();
    expect(SwitchReason.HardThreshold).toBeDefined();
    expect(SwitchReason.RateLimit429).toBeDefined();
    expect(SwitchReason.ProcessCrash).toBeDefined();
    expect(SwitchReason.Manual).toBeDefined();
    expect(SwitchReason.CircuitBreaker).toBeDefined();
    expect(SwitchReason.RestartFailures).toBeDefined();
  });
});

function makeSwitchAccounts(): AccountInfo[] {
  return [
    { name: 'primary', configDir: '/tmp/primary', priority: 1, enabled: true, state: 'HEALTHY', score: 20, cooldownUntil: null },
    { name: 'account2', configDir: '/tmp/account2', priority: 2, enabled: true, state: 'HEALTHY', score: 80, cooldownUntil: null },
    { name: 'account3', configDir: '/tmp/account3', priority: 3, enabled: true, state: 'HEALTHY', score: 70, cooldownUntil: null },
  ];
}

function makeState(overrides: Partial<SessionState> = {}): SessionState {
  const now = new Date().toISOString();
  return {
    aisup_session_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    status: 'ACTIVE',
    account: 'primary',
    tmux_name: 'aisup-aaaaaaaa',
    tmux_session_id: '$1',
    pane_id: '%1',
    cwd: '/tmp/project',
    launch_started_at: now,
    claude_session_id: '11111111-2222-3333-4444-555555555555',
    transcript_path: '/tmp/primary/projects/p.jsonl',
    plan_path: null,
    active_skill: null,
    output_log_path: '/tmp/output.log',
    switch_tx: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

describe('performSwitch transaction persistence', () => {
  it('persists switch_tx phase transitions and clears it after successful switch', async () => {
    const state = makeState();
    const patched: Array<Partial<SessionState>> = [];
    const manager = {
      readState: () => state,
      patchState: (_id: string, patch: Partial<SessionState>) => {
        patched.push(patch);
      },
      terminateRunnerForSwitch: async () => undefined,
      destroyTmuxSessionByName: () => undefined,
    };
    const journal = { append: vi.fn().mockResolvedValue(undefined) };

    const result = await performSwitch(
      {
        aisupSessionId: state.aisup_session_id,
        claudeSessionId: state.claude_session_id,
        transcriptPath: null,
        activeSkill: null,
        planFilePath: null,
        sourceAccount: 'primary',
        targetAccount: 'account2',
        reason: SwitchReason.Manual,
        selectionMode: 'manual',
      },
      makeSwitchAccounts(),
      {
        sessionManager: manager as never,
        journal,
        createSessionForTarget: async (target) => makeState({
          status: 'ACTIVE',
          account: target.name,
          tmux_name: 'aisup-aaaaaaaa',
          tmux_session_id: '$2',
          pane_id: '%2',
        }),
      }
    );

    expect(result.status).toBe('completed');
    const phases = patched
      .map((patch) => patch.switch_tx?.switch_phase)
      .filter(Boolean);
    expect(phases).toEqual(expect.arrayContaining(['snapshot', 'stopping', 'source_destroyed', 'creating']));
    const creatingTx = patched.find((patch) => patch.switch_tx?.switch_phase === 'creating')?.switch_tx;
    expect(creatingTx?.tried_accounts).toContain('account2');
    expect(new Date(creatingTx?.phase_timestamps.creating ?? '').toISOString()).toBe(creatingTx?.phase_timestamps.creating);
    expect(patched.at(-1)).toMatchObject({ switch_tx: null, status: 'ACTIVE', account: 'account2' });
  });

  it('marks the logical session EXHAUSTED and clears switch_tx after all targets fail', async () => {
    const state = makeState();
    const patched: Array<Partial<SessionState>> = [];
    const manager = {
      readState: () => state,
      patchState: (_id: string, patch: Partial<SessionState>) => {
        patched.push(patch);
      },
      terminateRunnerForSwitch: async () => undefined,
      destroyTmuxSessionByName: () => undefined,
    };

    const result = await performSwitch(
      {
        aisupSessionId: state.aisup_session_id,
        claudeSessionId: state.claude_session_id,
        transcriptPath: null,
        activeSkill: null,
        planFilePath: null,
        sourceAccount: 'primary',
        targetAccount: 'account2',
        reason: SwitchReason.RateLimit429,
        selectionMode: 'automatic',
      },
      makeSwitchAccounts(),
      {
        sessionManager: manager as never,
        journal: { append: vi.fn().mockResolvedValue(undefined) },
        createSessionForTarget: async () => {
          throw new Error('runner refused');
        },
      }
    );

    expect(result.status).toBe('exhausted');
    expect(result.triedAccounts).toEqual(['account2', 'account3']);
    expect(patched.at(-1)).toMatchObject({ status: 'EXHAUSTED', switch_tx: null });
  });
});

describe('selectSwitchTarget', () => {
  it('requires a strictly better target for soft-threshold switches', () => {
    const accounts = [
      { name: 'primary', configDir: '/a', priority: 1, enabled: true, state: 'DEGRADED' as const, score: 80, cooldownUntil: null },
      { name: 'account2', configDir: '/b', priority: 2, enabled: true, state: 'HEALTHY' as const, score: 70, cooldownUntil: null },
    ];
    expect(selectSwitchTarget(accounts, 'primary', [], { reason: SwitchReason.SoftThreshold, currentScore: 80 })).toBeNull();
  });
});
