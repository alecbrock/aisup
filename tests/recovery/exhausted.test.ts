import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ExhaustedRecovery, resumeExhaustedSession } from '../../src/recovery/exhausted.js';
import { CircuitBreaker } from '../../src/accounts/circuit-breaker.js';
import { SwitchReason } from '../../src/failover/types.js';
import type { RecoveryConfig } from '../../src/config/schema.js';

const RECOVERY: RecoveryConfig = {
  auto_resume_exhausted: true,
  exhausted_poll_interval_s: 60,
  network_error_threshold: 3,
  max_exhausted_retries: 3,
};

function makeAccounts(...names: string[]) {
  return names.map((name, i) => ({
    name,
    configDir: `/tmp/${name}`,
    priority: i + 1,
    enabled: true,
    state: 'HEALTHY' as const,
    score: null,
    cooldownUntil: null,
  }));
}

describe('ExhaustedRecovery poller', () => {
  let tmpDir: string;
  let cb: CircuitBreaker;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'aisup-exh-'));
    cb = new CircuitBreaker({ maxFailures: 1, cooldownSeconds: 600, statePath: join(tmpDir, 'cb.json') });
  });
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  const pollOnce = (er: ExhaustedRecovery, id: string): Promise<void> =>
    (er as unknown as { pollOnce(id: string): Promise<void> }).pollOnce(id);

  const build = (overrides: Partial<RecoveryConfig> = {}, onAccountAvailable = vi.fn().mockResolvedValue(undefined)) => {
    const journal = { append: vi.fn().mockResolvedValue(undefined) };
    const accountRegistry = { getAll: vi.fn().mockReturnValue(makeAccounts('primary', 'secondary')) };
    const er = new ExhaustedRecovery({
      circuitBreaker: cb,
      accountRegistry: accountRegistry as never,
      config: { ...RECOVERY, ...overrides },
      journal: journal as never,
      onAccountAvailable,
    });
    return { er, journal, accountRegistry, onAccountAvailable };
  };

  it('start arms polling and emits recovery.exhausted_polling_started', () => {
    const { er, journal } = build();
    er.start('sess-1');
    expect(er.isPolling('sess-1')).toBe(true);
    expect(journal.append).toHaveBeenCalledWith(expect.objectContaining({
      event_type: 'recovery.exhausted_polling_started',
      aisup_session_id: 'sess-1',
    }));
    er.stopAll();
  });

  it('does not arm polling when auto_resume_exhausted is disabled', () => {
    const { er, journal } = build({ auto_resume_exhausted: false });
    er.start('sess-1');
    expect(er.isPolling('sess-1')).toBe(false);
    expect(journal.append).not.toHaveBeenCalled();
  });

  it('does not invoke onAccountAvailable while every account is in cooldown (CB OPEN)', async () => {
    const { er, onAccountAvailable } = build();
    cb.recordFailure('primary'); // OPEN (maxFailures: 1)
    cb.recordFailure('secondary');
    er.start('sess-1');
    await pollOnce(er, 'sess-1');
    expect(onAccountAvailable).not.toHaveBeenCalled();
    er.stopAll();
  });

  it('invokes onAccountAvailable with the runnable account once a cooldown expires', async () => {
    const { er, onAccountAvailable } = build();
    cb.recordFailure('primary');   // OPEN
    cb.recordFailure('secondary'); // OPEN
    er.start('sess-1');
    await pollOnce(er, 'sess-1');
    expect(onAccountAvailable).not.toHaveBeenCalled();

    cb.overrideTripTime('secondary', new Date(Date.now() - 700_000)); // cooldown elapsed → HALF_OPEN
    await pollOnce(er, 'sess-1');
    expect(onAccountAvailable).toHaveBeenCalledWith('sess-1', 'secondary');
    er.stopAll();
  });

  it('emits recovery.exhausted_max_retries and stops after the retry budget is spent', async () => {
    // onAccountAvailable never stops polling → every attempt is treated as a failure.
    const { er, journal, onAccountAvailable } = build({ max_exhausted_retries: 2 });
    er.start('sess-1'); // primary CB CLOSED → always runnable
    await pollOnce(er, 'sess-1'); // attempt 1
    expect(er.isPolling('sess-1')).toBe(true);
    await pollOnce(er, 'sess-1'); // attempt 2 → budget spent

    expect(onAccountAvailable).toHaveBeenCalledTimes(2);
    expect(journal.append).toHaveBeenCalledWith(expect.objectContaining({
      event_type: 'recovery.exhausted_max_retries',
      aisup_session_id: 'sess-1',
    }));
    expect(er.isPolling('sess-1')).toBe(false);
  });

  it('stops polling when the resume succeeds (onAccountAvailable stops it) — no max-retries', async () => {
    const onAccountAvailable = vi.fn().mockImplementation(async (id: string) => { er.stop(id); });
    let er!: ExhaustedRecovery;
    ({ er } = build({ max_exhausted_retries: 1 }, onAccountAvailable));
    er.start('sess-1');
    await pollOnce(er, 'sess-1');
    expect(er.isPolling('sess-1')).toBe(false);
  });

  it('stopAll stops every armed session and emits polling_stopped', () => {
    const { er, journal } = build();
    er.start('sess-1');
    er.start('sess-2');
    er.stopAll();
    expect(er.isPolling('sess-1')).toBe(false);
    expect(er.isPolling('sess-2')).toBe(false);
    expect(journal.append).toHaveBeenCalledWith(expect.objectContaining({
      event_type: 'recovery.exhausted_polling_stopped',
      aisup_session_id: 'sess-1',
    }));
  });
});

describe('resumeExhaustedSession', () => {
  const exhaustedState = {
    aisup_session_id: 'sess-1',
    status: 'EXHAUSTED' as const,
    account: 'primary',
    claude_session_id: 'claude-abc',
    transcript_path: '/tmp/primary/transcript.jsonl',
    active_skill: '/spec',
    plan_path: '/tmp/plan.md',
    cwd: '/tmp/work',
  };

  const buildDeps = (performSwitch: ReturnType<typeof vi.fn>, state: unknown = exhaustedState) => {
    const journal = { append: vi.fn().mockResolvedValue(undefined) };
    const onResumed = vi.fn();
    return {
      journal,
      onResumed,
      deps: {
        sessionManager: { readState: vi.fn().mockReturnValue(state) },
        accounts: makeAccounts('primary', 'secondary'),
        journal: journal as never,
        performSwitch,
        switchDeps: { sessionManager: {}, journal: {}, createSessionForTarget: vi.fn() } as never,
        onResumed,
      },
    };
  };

  it('invokes performSwitch with the persisted source account and the runnable target', async () => {
    const performSwitch = vi.fn().mockResolvedValue({ status: 'completed', targetAccount: 'secondary', triedAccounts: ['secondary'] });
    const { deps } = buildDeps(performSwitch);
    await resumeExhaustedSession('sess-1', 'secondary', deps as never);
    expect(performSwitch).toHaveBeenCalledWith(
      expect.objectContaining({
        aisupSessionId: 'sess-1',
        sourceAccount: 'primary',     // persisted source, NOT a state flip
        targetAccount: 'secondary',
        claudeSessionId: 'claude-abc',
        transcriptPath: '/tmp/primary/transcript.jsonl',
        reason: SwitchReason.CircuitBreaker,
      }),
      expect.any(Array),
      expect.anything(),
    );
  });

  it('emits recovery.exhausted_resumed and returns true only after a completed launch', async () => {
    const performSwitch = vi.fn().mockResolvedValue({ status: 'completed', targetAccount: 'secondary', triedAccounts: ['secondary'] });
    const { deps, journal, onResumed } = buildDeps(performSwitch);
    const ok = await resumeExhaustedSession('sess-1', 'secondary', deps as never);
    expect(ok).toBe(true);
    expect(onResumed).toHaveBeenCalledWith('secondary');
    expect(journal.append).toHaveBeenCalledWith(expect.objectContaining({
      event_type: 'recovery.exhausted_resumed',
      aisup_session_id: 'sess-1',
    }));
  });

  it('returns false and emits no resumed event when the relaunch exhausts', async () => {
    const performSwitch = vi.fn().mockResolvedValue({ status: 'exhausted', triedAccounts: ['secondary'], error: 'all failed' });
    const { deps, journal } = buildDeps(performSwitch);
    const ok = await resumeExhaustedSession('sess-1', 'secondary', deps as never);
    expect(ok).toBe(false);
    expect(journal.append).not.toHaveBeenCalledWith(expect.objectContaining({ event_type: 'recovery.exhausted_resumed' }));
  });

  it('bails without calling performSwitch when the session is no longer EXHAUSTED', async () => {
    const performSwitch = vi.fn();
    const { deps } = buildDeps(performSwitch, { ...exhaustedState, status: 'ACTIVE' });
    const ok = await resumeExhaustedSession('sess-1', 'secondary', deps as never);
    expect(ok).toBe(false);
    expect(performSwitch).not.toHaveBeenCalled();
  });
});
