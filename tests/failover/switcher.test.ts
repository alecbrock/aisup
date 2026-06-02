import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SwitchReason } from '../../src/failover/types.js';
import { performSwitch, selectSwitchTarget, validateManualFailoverTarget, handleNoTarget } from '../../src/failover/switcher.js';
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

  it('launches fresh and emits migration.skipped_no_transcript when transcript is null but claude session is known', async () => {
    const state = makeState({ transcript_path: null });
    const journal = { append: vi.fn().mockResolvedValue(undefined) };
    const launchModes: Array<'resumed' | 'fresh'> = [];
    const manager = {
      readState: () => state,
      patchState: vi.fn(),
      terminateRunnerForSwitch: async () => undefined,
      destroyTmuxSessionByName: () => undefined,
    };

    const result = await performSwitch(
      {
        aisupSessionId: state.aisup_session_id,
        claudeSessionId: state.claude_session_id, // known session id
        transcriptPath: null,                     // but no transcript to migrate
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
        journal,
        createSessionForTarget: async (target, _snapshot, launchMode) => {
          launchModes.push(launchMode);
          return makeState({ account: target.name, tmux_session_id: '$2', pane_id: '%2' });
        },
      }
    );

    expect(result.status).toBe('completed');
    expect(launchModes[0]).toBe('fresh');
    const events = journal.append.mock.calls.map((c) => c[0] as { event_type: string; details: Record<string, unknown> });
    expect(events.some((e) => e.event_type === 'migration.skipped_no_transcript')).toBe(true);
    const completed = events.find((e) => e.event_type === 'account.switch' && e.details.phase === 'completed');
    expect(completed?.details.launch_mode).toBe('fresh');
  });

  it('launches fresh when migration fails even though a claude session id is set', async () => {
    const state = makeState({ transcript_path: '/nonexistent/dir/x.jsonl' });
    const journal = { append: vi.fn().mockResolvedValue(undefined) };
    const launchModes: Array<'resumed' | 'fresh'> = [];
    const manager = {
      readState: () => state,
      patchState: vi.fn(),
      terminateRunnerForSwitch: async () => undefined,
      destroyTmuxSessionByName: () => undefined,
    };

    const result = await performSwitch(
      {
        aisupSessionId: state.aisup_session_id,
        claudeSessionId: state.claude_session_id,
        transcriptPath: '/nonexistent/dir/x.jsonl', // migrateTranscript throws (source missing)
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
        journal,
        createSessionForTarget: async (target, _snapshot, launchMode) => {
          launchModes.push(launchMode);
          return makeState({ account: target.name, tmux_session_id: '$2', pane_id: '%2' });
        },
      }
    );

    expect(result.status).toBe('completed');
    expect(launchModes[0]).toBe('fresh');
    const events = journal.append.mock.calls.map((c) => c[0] as { event_type: string; details: Record<string, unknown> });
    const invalid = events.find((e) => e.event_type === 'migration.invalid_path');
    expect(invalid).toBeDefined();
    // R7: safe reason enum, never raw exception text.
    expect(invalid?.details.reason).toBe('source_not_found');
    expect(invalid?.details.error).toBeUndefined();
  });

  it('resumes when migration into the target account succeeds', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'aisup-switch-mig-'));
    try {
      const srcConfig = join(tmpDir, 'primary');
      const tgtConfig = join(tmpDir, 'account2');
      mkdirSync(join(srcConfig, 'projects', 'p'), { recursive: true });
      mkdirSync(tgtConfig, { recursive: true });
      const sessionUuid = '11111111-2222-3333-4444-555555555555';
      const transcriptPath = join(srcConfig, 'projects', 'p', `${sessionUuid}.jsonl`);
      writeFileSync(transcriptPath, '{"type":"msg"}\n');

      const accounts: AccountInfo[] = [
        { name: 'primary', configDir: srcConfig, priority: 1, enabled: true, state: 'HEALTHY', score: 20, cooldownUntil: null },
        { name: 'account2', configDir: tgtConfig, priority: 2, enabled: true, state: 'HEALTHY', score: 80, cooldownUntil: null },
      ];
      const state = makeState({ transcript_path: transcriptPath, claude_session_id: sessionUuid });
      const journal = { append: vi.fn().mockResolvedValue(undefined) };
      const launchModes: Array<'resumed' | 'fresh'> = [];
      const manager = {
        readState: () => state,
        patchState: vi.fn(),
        terminateRunnerForSwitch: async () => undefined,
        destroyTmuxSessionByName: () => undefined,
      };

      const result = await performSwitch(
        {
          aisupSessionId: state.aisup_session_id,
          claudeSessionId: sessionUuid,
          transcriptPath,
          activeSkill: null,
          planFilePath: null,
          sourceAccount: 'primary',
          targetAccount: 'account2',
          reason: SwitchReason.RateLimit429,
          selectionMode: 'manual',
        },
        accounts,
        {
          sessionManager: manager as never,
          journal,
          createSessionForTarget: async (target, _snapshot, launchMode) => {
            launchModes.push(launchMode);
            return makeState({ account: target.name, tmux_session_id: '$2', pane_id: '%2' });
          },
        }
      );

      expect(result.status).toBe('completed');
      expect(launchModes[0]).toBe('resumed');
      const events = journal.append.mock.calls.map((c) => c[0] as { event_type: string; details: Record<string, unknown> });
      const completed = events.find((e) => e.event_type === 'account.switch' && e.details.phase === 'completed');
      expect(completed?.details.launch_mode).toBe('resumed');
      // R7: migration.completed carries safe target metadata + source_size.
      const migration = events.find((e) => e.event_type === 'migration.completed');
      expect(migration?.details.target_path).toContain(tgtConfig);
      expect(migration?.details.target_sha256).toEqual(migration?.details.source_sha256);
      expect(migration?.details.source_size).toBe(Buffer.byteLength('{"type":"msg"}\n'));
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('skips COOLDOWN accounts during automatic retry after the primary target fails', async () => {
    const state = makeState();
    const accounts: AccountInfo[] = [
      { name: 'primary', configDir: '/tmp/primary', priority: 1, enabled: true, state: 'HEALTHY', score: 20, cooldownUntil: null },
      { name: 'account2', configDir: '/tmp/account2', priority: 2, enabled: true, state: 'HEALTHY', score: 80, cooldownUntil: null },
      { name: 'account3', configDir: '/tmp/account3', priority: 3, enabled: true, state: 'COOLDOWN', score: 70, cooldownUntil: null },
    ];
    const manager = {
      readState: () => state,
      patchState: vi.fn(),
      terminateRunnerForSwitch: async () => undefined,
      destroyTmuxSessionByName: () => undefined,
    };

    const result = await performSwitch(
      {
        aisupSessionId: state.aisup_session_id,
        claudeSessionId: null,
        transcriptPath: null,
        activeSkill: null,
        planFilePath: null,
        sourceAccount: 'primary',
        targetAccount: 'account2',
        reason: SwitchReason.RateLimit429,
        selectionMode: 'automatic',
      },
      accounts,
      {
        sessionManager: manager as never,
        journal: { append: vi.fn().mockResolvedValue(undefined) },
        createSessionForTarget: async () => { throw new Error('runner refused'); },
      }
    );

    expect(result.status).toBe('exhausted');
    // account3 is COOLDOWN → excluded from automatic retry.
    expect(result.triedAccounts).toEqual(['account2']);
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

  // F1 regression: resume-from-EXHAUSTED must not terminate the already-destroyed source pane.
  it('resumes an EXHAUSTED session without terminating the missing source pane', async () => {
    const state = makeState({ status: 'EXHAUSTED' });
    const terminate = vi.fn(async () => { throw new Error('no server running / pane missing'); });
    const manager = {
      readState: () => state,
      patchState: vi.fn(),
      terminateRunnerForSwitch: terminate,
      destroyTmuxSessionByName: () => undefined,
    };

    const result = await performSwitch(
      {
        aisupSessionId: state.aisup_session_id,
        claudeSessionId: null,
        transcriptPath: null,
        activeSkill: null,
        planFilePath: null,
        sourceAccount: 'primary',
        targetAccount: 'account2',
        reason: SwitchReason.CircuitBreaker,
        selectionMode: 'automatic',
      },
      makeSwitchAccounts(),
      {
        sessionManager: manager as never,
        journal: { append: vi.fn().mockResolvedValue(undefined) },
        createSessionForTarget: async (target) => makeState({ status: 'ACTIVE', account: target.name, tmux_session_id: '$2', pane_id: '%2' }),
      }
    );

    // Termination is skipped (source already gone), so the throwing op never aborts the relaunch.
    expect(terminate).not.toHaveBeenCalled();
    expect(result.status).toBe('completed');
    expect(result.targetAccount).toBe('account2');
  });

  // F2 regression: automatic selection must not relaunch into an ineligible primary target.
  it('skips an UNAVAILABLE primary target during automatic selection', async () => {
    const state = makeState({ status: 'EXHAUSTED' });
    const accounts: AccountInfo[] = [
      { name: 'primary', configDir: '/tmp/primary', priority: 1, enabled: true, state: 'HEALTHY', score: 20, cooldownUntil: null },
      { name: 'account2', configDir: '/tmp/account2', priority: 2, enabled: true, state: 'UNAVAILABLE', score: 80, cooldownUntil: null },
    ];
    const created: string[] = [];

    const result = await performSwitch(
      {
        aisupSessionId: state.aisup_session_id,
        claudeSessionId: null,
        transcriptPath: null,
        activeSkill: null,
        planFilePath: null,
        sourceAccount: 'primary',
        targetAccount: 'account2',
        reason: SwitchReason.CircuitBreaker,
        selectionMode: 'automatic',
      },
      accounts,
      {
        sessionManager: { readState: () => state, patchState: vi.fn(), terminateRunnerForSwitch: async () => undefined, destroyTmuxSessionByName: () => undefined } as never,
        journal: { append: vi.fn().mockResolvedValue(undefined) },
        createSessionForTarget: async (target) => { created.push(target.name); return makeState({ status: 'ACTIVE', account: target.name }); },
      }
    );

    // account2 is UNAVAILABLE; the source 'primary' is excluded from retry → no eligible target.
    expect(created).not.toContain('account2');
    expect(result.status).toBe('exhausted');
  });

  // F2 boundary: a manual operator override still launches a non-HEALTHY primary it explicitly chose.
  it('launches a COOLDOWN primary target for a manual failover (operator override)', async () => {
    const state = makeState();
    const accounts: AccountInfo[] = [
      { name: 'primary', configDir: '/tmp/primary', priority: 1, enabled: true, state: 'HEALTHY', score: 20, cooldownUntil: null },
      { name: 'account2', configDir: '/tmp/account2', priority: 2, enabled: true, state: 'COOLDOWN', score: 80, cooldownUntil: null },
    ];
    const created: string[] = [];

    const result = await performSwitch(
      {
        aisupSessionId: state.aisup_session_id,
        claudeSessionId: null,
        transcriptPath: null,
        activeSkill: null,
        planFilePath: null,
        sourceAccount: 'primary',
        targetAccount: 'account2',
        reason: SwitchReason.Manual,
        selectionMode: 'manual',
      },
      accounts,
      {
        sessionManager: { readState: () => state, patchState: vi.fn(), terminateRunnerForSwitch: async () => undefined, destroyTmuxSessionByName: () => undefined } as never,
        journal: { append: vi.fn().mockResolvedValue(undefined) },
        createSessionForTarget: async (target) => { created.push(target.name); return makeState({ status: 'ACTIVE', account: target.name }); },
      }
    );

    expect(created).toEqual(['account2']);
    expect(result.status).toBe('completed');
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

  it('selects a strictly better target for soft-threshold switches when one exists', () => {
    const accounts: AccountInfo[] = [
      { name: 'primary', configDir: '/a', priority: 1, enabled: true, state: 'DEGRADED', score: 40, cooldownUntil: null },
      { name: 'account2', configDir: '/b', priority: 2, enabled: true, state: 'HEALTHY', score: 90, cooldownUntil: null },
    ];
    expect(selectSwitchTarget(accounts, 'primary', [], { reason: SwitchReason.SoftThreshold, currentScore: 40 })?.name).toBe('account2');
  });

  // Canonical-selector behaviours (selectSwitchTarget is the single selector for
  // start admission, dry-run, soft/hard failover, and automatic retry).
  it('returns the highest-scoring HEALTHY account, lower priority notwithstanding', () => {
    const accounts: AccountInfo[] = [
      { name: 'primary', configDir: '/a', priority: 1, enabled: true, state: 'HEALTHY', score: 50, cooldownUntil: null },
      { name: 'account2', configDir: '/b', priority: 2, enabled: true, state: 'HEALTHY', score: 80, cooldownUntil: null },
    ];
    expect(selectSwitchTarget(accounts, 'none', [])?.name).toBe('account2');
  });

  it('treats DEGRADED as eligible and excludes UNAVAILABLE', () => {
    const accounts: AccountInfo[] = [
      { name: 'primary', configDir: '/a', priority: 1, enabled: true, state: 'UNAVAILABLE', score: 90, cooldownUntil: null },
      { name: 'account2', configDir: '/b', priority: 2, enabled: true, state: 'DEGRADED', score: 30, cooldownUntil: null },
    ];
    expect(selectSwitchTarget(accounts, 'none', [])?.name).toBe('account2');
  });

  it('returns null when every account is UNAVAILABLE or COOLDOWN', () => {
    const accounts: AccountInfo[] = [
      { name: 'primary', configDir: '/a', priority: 1, enabled: true, state: 'UNAVAILABLE', score: 90, cooldownUntil: null },
      { name: 'account2', configDir: '/b', priority: 2, enabled: true, state: 'COOLDOWN', score: 70, cooldownUntil: null },
    ];
    expect(selectSwitchTarget(accounts, 'none', [])).toBeNull();
  });

  it('skips disabled accounts', () => {
    const accounts: AccountInfo[] = [
      { name: 'primary', configDir: '/a', priority: 1, enabled: false, state: 'HEALTHY', score: 90, cooldownUntil: null },
      { name: 'account2', configDir: '/b', priority: 2, enabled: true, state: 'HEALTHY', score: 40, cooldownUntil: null },
    ];
    expect(selectSwitchTarget(accounts, 'none', [])?.name).toBe('account2');
  });

  it('excludes the current account and explicitly excluded names', () => {
    const accounts: AccountInfo[] = [
      { name: 'primary', configDir: '/a', priority: 1, enabled: true, state: 'HEALTHY', score: 90, cooldownUntil: null },
      { name: 'account2', configDir: '/b', priority: 2, enabled: true, state: 'HEALTHY', score: 40, cooldownUntil: null },
    ];
    expect(selectSwitchTarget(accounts, 'primary', [])?.name).toBe('account2');
    expect(selectSwitchTarget(accounts, 'none', ['primary'])?.name).toBe('account2');
  });

  it('falls back to priority order when scores are null', () => {
    const accounts: AccountInfo[] = [
      { name: 'primary', configDir: '/a', priority: 1, enabled: true, state: 'HEALTHY', score: null, cooldownUntil: null },
      { name: 'account2', configDir: '/b', priority: 2, enabled: true, state: 'HEALTHY', score: null, cooldownUntil: null },
    ];
    expect(selectSwitchTarget(accounts, 'none', [])?.name).toBe('primary');
  });
});

describe('handleNoTarget', () => {
  function makeDeps() {
    const patches: Array<Partial<SessionState>> = [];
    const visible: unknown[] = [];
    const append = vi.fn().mockResolvedValue(undefined);
    const notifyExhausted = vi.fn().mockResolvedValue(undefined);
    return {
      patches,
      visible,
      append,
      notifyExhausted,
      deps: {
        sessionManager: { patchState: (_id: string, patch: Partial<SessionState>) => { patches.push(patch); } },
        journal: { append },
        setSessionVisible: (s: unknown) => { visible.push(s); },
        notifyExhausted,
      },
    };
  }

  it('keeps a soft-threshold no-better-target session ACTIVE and emits a nonterminal event', async () => {
    const t = makeDeps();
    const result = await handleNoTarget(
      { sessionId: 'sess-1', fromAccount: 'primary', reason: SwitchReason.SoftThreshold },
      t.deps as never
    );
    expect(result.terminal).toBe(false);
    // No state transition, no visibility flip, no Slack notification.
    expect(t.patches).toHaveLength(0);
    expect(t.visible).toHaveLength(0);
    expect(t.notifyExhausted).not.toHaveBeenCalled();
    const events = t.append.mock.calls.map((c) => c[0] as { event_type: string; details: Record<string, unknown> });
    const noTarget = events.find((e) => e.event_type === 'failover.no_target_available');
    expect(noTarget?.details.terminal).toBe(false);
    expect(noTarget?.details.requires_better_soft_target).toBe(true);
    expect(events.some((e) => e.event_type === 'session.exhausted')).toBe(false);
  });

  it.each([SwitchReason.HardThreshold, SwitchReason.RateLimit429])(
    'persists EXHAUSTED and emits terminal events for reason %s',
    async (reason) => {
      const t = makeDeps();
      const result = await handleNoTarget(
        { sessionId: 'sess-2', fromAccount: 'primary', reason, triedAccounts: ['account2'] },
        t.deps as never
      );
      expect(result.terminal).toBe(true);
      // Persisted EXHAUSTED with switch_tx cleared.
      expect(t.patches).toContainEqual({ status: 'EXHAUSTED', switch_tx: null });
      // API visibility refreshed and Slack notified.
      expect(t.visible).toContainEqual({ status: 'EXHAUSTED', aisup_session_id: 'sess-2', hasTmux: false });
      expect(t.notifyExhausted).toHaveBeenCalledWith('sess-2');
      const events = t.append.mock.calls.map((c) => c[0] as { event_type: string; details: Record<string, unknown> });
      const noTarget = events.find((e) => e.event_type === 'failover.no_target_available');
      expect(noTarget?.details.terminal).toBe(true);
      expect(noTarget?.details.requires_better_soft_target).toBe(false);
      expect(events.some((e) => e.event_type === 'session.exhausted')).toBe(true);
    }
  );
});
