import { describe, it, expect, vi } from 'vitest';
import { SwitchReason, type SelectionRationale } from '../../src/failover/types.js';
import { explainSelection, performSwitch } from '../../src/failover/switcher.js';
import type { AccountInfo } from '../../src/accounts/types.js';
import type { SessionState } from '../../src/session/types.js';

const acct = (o: Partial<AccountInfo> & { name: string }): AccountInfo => ({
  configDir: `/home/.claude-${o.name}`,
  priority: 1,
  enabled: true,
  state: 'HEALTHY',
  score: null,
  cooldownUntil: null,
  ...o,
});

describe('explainSelection (C2 failover rationale)', () => {
  it('reports reason code, per-candidate score + exclusion reason, and the chosen target', () => {
    const accounts = [
      acct({ name: 'primary', priority: 1, score: 30 }),        // current
      acct({ name: 'account2', priority: 2, score: 60 }),        // eligible winner
      acct({ name: 'account3', priority: 3, score: 90, state: 'COOLDOWN' }), // excluded: cooldown
      acct({ name: 'account4', priority: 4, score: 80, enabled: false }),    // excluded: disabled
    ];

    const { chosen, rationale } = explainSelection(accounts, 'primary', [], { reason: SwitchReason.RateLimit429 });

    expect(chosen?.name).toBe('account2');
    expect(rationale.reason_code).toBe(SwitchReason.RateLimit429);
    expect(rationale.chosen).toBe('account2');

    const byName = Object.fromEntries(rationale.candidates.map((c) => [c.name, c]));
    expect(byName.primary.excluded_reason).toBe('is_current');
    expect(byName.account2.excluded_reason).toBeNull();
    expect(byName.account2.score).toBe(60);
    expect(byName.account3.excluded_reason).toBe('cooldown');
    expect(byName.account4.excluded_reason).toBe('disabled');
  });

  it('marks eligible-but-not-strictly-better candidates on a soft threshold', () => {
    const accounts = [
      acct({ name: 'primary', priority: 1, score: 50 }),   // current (score 50)
      acct({ name: 'account2', priority: 2, score: 40 }),  // eligible by state, but NOT better than 50
      acct({ name: 'account3', priority: 3, score: 70 }),  // strictly better -> chosen
    ];

    const { chosen, rationale } = explainSelection(accounts, 'primary', [], {
      reason: SwitchReason.SoftThreshold,
      currentScore: 50,
    });

    expect(chosen?.name).toBe('account3');
    const byName = Object.fromEntries(rationale.candidates.map((c) => [c.name, c]));
    expect(byName.account2.excluded_reason).toBe('below_current_score');
    expect(byName.account3.excluded_reason).toBeNull();
  });

  it('returns chosen=null with candidate reasons when nothing is eligible', () => {
    const accounts = [
      acct({ name: 'primary', priority: 1, score: 30 }),
      acct({ name: 'account2', priority: 2, state: 'UNAVAILABLE' }),
    ];
    const { chosen, rationale } = explainSelection(accounts, 'primary', [], { reason: SwitchReason.HardThreshold });
    expect(chosen).toBeNull();
    expect(rationale.chosen).toBeNull();
    const byName = Object.fromEntries(rationale.candidates.map((c) => [c.name, c]));
    expect(byName.account2.excluded_reason).toBe('unavailable');
  });
});

describe('performSwitch persists the rationale on account.switch', () => {
  const makeState = (o: Partial<SessionState> = {}): SessionState => ({
    aisup_session_id: 'aisup-abcdef12',
    account: 'primary',
    status: 'ACTIVE',
    tmux_name: 'aisup-abcdef12',
    tmux_session_id: '$1',
    pane_id: '%1',
    claude_session_id: null,
    transcript_path: null,
    active_skill: null,
    plan_path: null,
    cwd: '/tmp',
    updated_at: new Date().toISOString(),
    switch_tx: null,
    ...o,
  } as SessionState);

  it('includes the rationale in the completed account.switch event details', async () => {
    const state = makeState();
    const journal = { append: vi.fn().mockResolvedValue(undefined) };
    const manager = {
      readState: () => state,
      patchState: vi.fn(),
      terminateRunnerForSwitch: async () => undefined,
      destroyTmuxSessionByName: () => undefined,
    };
    const accounts = [
      acct({ name: 'primary', priority: 1, score: 20 }),
      acct({ name: 'account2', priority: 2, score: 80 }),
    ];
    const rationale: SelectionRationale = {
      reason_code: SwitchReason.RateLimit429,
      candidates: [
        { name: 'primary', score: 20, excluded_reason: 'is_current' },
        { name: 'account2', score: 80, excluded_reason: null },
      ],
      chosen: 'account2',
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
        rationale,
      },
      accounts,
      {
        sessionManager: manager as never,
        journal,
        createSessionForTarget: async (target) => makeState({ account: target.name, tmux_session_id: '$2', pane_id: '%2' }),
      }
    );

    expect(result.status).toBe('completed');
    const events = journal.append.mock.calls.map((c) => c[0] as { event_type: string; details: Record<string, unknown> });
    const completed = events.find((e) => e.event_type === 'account.switch' && e.details.phase === 'completed');
    expect(completed?.details.rationale).toMatchObject({ reason_code: '429', chosen: 'account2' });
  });
});
