import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Partial-mock tmux so panePid returns a deterministic pid without a real pane.
vi.mock('../../src/session/tmux.js', async (importActual) => {
  const actual = await importActual<typeof import('../../src/session/tmux.js')>();
  return { ...actual, panePid: vi.fn(() => 4242) };
});

import { SessionManager } from '../../src/session/manager.js';
import { panePid } from '../../src/session/tmux.js';

const ID = 'aisup-abcdef12';

function seed(stateDir: string, status: string): void {
  mkdirSync(join(stateDir, ID), { recursive: true });
  writeFileSync(join(stateDir, ID, 'state.json'), JSON.stringify({
    aisup_session_id: ID, status, account: 'primary', tmux_name: 'aisup-abcdef12',
    tmux_session_id: '$1', pane_id: '%1', cwd: '/tmp', updated_at: new Date().toISOString(),
  }));
}

describe('C9: session pause/resume', () => {
  let dir: string;
  let stateDir: string;
  let manager: SessionManager;
  let kill: MockInstance<typeof process.kill>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aisup-pause-'));
    stateDir = join(dir, 'sessions');
    manager = new SessionManager({ tmuxSocket: 'aisup-test', stateDir, outputLogMaxSizeMb: 50 });
    kill = vi.spyOn(process, 'kill').mockImplementation((() => true) as never);
    vi.mocked(panePid).mockReturnValue(4242);
  });
  afterEach(() => { vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });

  it('pause SIGSTOPs the runner and marks the session PAUSED', async () => {
    seed(stateDir, 'ACTIVE');
    const res = await manager.pauseSession(ID);
    expect(res.ok).toBe(true);
    expect(kill).toHaveBeenCalledWith(4242, 'SIGSTOP');
    expect(manager.readState(ID)!.status).toBe('PAUSED');
  });

  it('resume SIGCONTs the runner and restores ACTIVE', async () => {
    seed(stateDir, 'PAUSED');
    const res = await manager.resumeSession(ID);
    expect(res.ok).toBe(true);
    expect(kill).toHaveBeenCalledWith(4242, 'SIGCONT');
    expect(manager.readState(ID)!.status).toBe('ACTIVE');
  });

  it('a PAUSED session is skipped by getActiveSession (idle/rate-limit loops skip it)', () => {
    seed(stateDir, 'PAUSED');
    expect(manager.getActiveSession()).toBeNull();
  });

  it('rejects pausing an already-paused session and resuming a non-paused one', async () => {
    seed(stateDir, 'PAUSED');
    expect((await manager.pauseSession(ID)).ok).toBe(false);
    seed(stateDir, 'ACTIVE');
    expect((await manager.resumeSession(ID)).ok).toBe(false);
  });

  it('reports not_found for an unknown session', async () => {
    expect((await manager.pauseSession('aisup-00000000')).reason).toBe('not_found');
  });
});
