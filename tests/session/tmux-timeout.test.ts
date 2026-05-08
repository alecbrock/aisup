/**
 * Pure unit tests for tmux timeout callback mechanism.
 * Mocks execFileSync to simulate timeout vs non-timeout errors.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock child_process before importing tmux module
vi.mock('node:child_process', () => ({
  execFileSync: vi.fn().mockReturnValue('ok'),
}));

import { setTmuxTimeoutHandler, sendText, destroyTmuxSession, listSessions } from '../../src/session/tmux.js';
import { execFileSync } from 'node:child_process';

function makeTimeoutError(signal = 'SIGTERM'): NodeJS.ErrnoException & { signal?: string; killed?: boolean } {
  const err = new Error('spawnSync tmux ETIMEDOUT') as NodeJS.ErrnoException & { signal?: string; killed?: boolean };
  err.killed = true;
  err.signal = signal;
  return err;
}

function makeRegularError(): NodeJS.ErrnoException {
  const err = new Error('no server running on /tmp/tmux-501/aisup-test') as NodeJS.ErrnoException;
  err.code = 'ENOENT';
  return err;
}

describe('setTmuxTimeoutHandler / tmuxWithTimeout', () => {
  let timeoutHandler: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    timeoutHandler = vi.fn();
    setTmuxTimeoutHandler(timeoutHandler);
  });

  afterEach(() => {
    // Reset to no-op handler after each test
    setTmuxTimeoutHandler(() => { /* no-op */ });
  });

  it('should call timeout handler with sanitized operation and target on real timeout (killed+SIGTERM)', () => {
    vi.mocked(execFileSync).mockImplementationOnce(() => { throw makeTimeoutError('SIGTERM'); });

    expect(() => sendText('aisup-test', 'aisup-abc12345', 'hello')).toThrow();
    expect(timeoutHandler).toHaveBeenCalledWith({
      operation: 'send-keys',
      target: 'aisup-abc12345',
      timeoutMs: 5000,
    });
  });

  it('should NOT call timeout handler for non-timeout exec error', () => {
    vi.mocked(execFileSync).mockImplementationOnce(() => { throw makeRegularError(); });

    expect(() => sendText('aisup-test', 'aisup-abc12345', 'hello')).toThrow();
    expect(timeoutHandler).not.toHaveBeenCalled();
  });

  it('should NOT call timeout handler when killed is false', () => {
    const err = makeTimeoutError('SIGTERM');
    err.killed = false;
    vi.mocked(execFileSync).mockImplementationOnce(() => { throw err; });

    expect(() => sendText('aisup-test', 'aisup-abc12345', 'hello')).toThrow();
    expect(timeoutHandler).not.toHaveBeenCalled();
  });

  it('should NOT call timeout handler when signal is not SIGTERM', () => {
    vi.mocked(execFileSync).mockImplementationOnce(() => { throw makeTimeoutError('SIGKILL'); });

    expect(() => sendText('aisup-test', 'aisup-abc12345', 'hello')).toThrow();
    expect(timeoutHandler).not.toHaveBeenCalled();
  });

  it('should include operation from tmux subcommand', () => {
    vi.mocked(execFileSync).mockImplementationOnce(() => { throw makeTimeoutError('SIGTERM'); });

    expect(() => destroyTmuxSession('aisup-test', 'aisup-abc12345')).not.toThrow(); // destroyTmuxSession catches errors
    // If kill-session times out, timeout handler should fire
    // (destroyTmuxSession swallows the error but the handler fires before that)
    // Actually we need to test a function that propagates the throw
    vi.mocked(execFileSync).mockImplementationOnce(() => { throw makeTimeoutError('SIGTERM'); });
    expect(() => sendText('aisup-test', 'aisup-abc12345', 'test')).toThrow();
    expect(timeoutHandler).toHaveBeenCalledWith(expect.objectContaining({ operation: 'send-keys' }));
  });

  it('should not expose args or full command path in handler call', () => {
    vi.mocked(execFileSync).mockImplementationOnce(() => { throw makeTimeoutError('SIGTERM'); });

    expect(() => sendText('aisup-test', 'aisup-abc12345', 'secret content')).toThrow();
    const call = timeoutHandler.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(JSON.stringify(call)).not.toContain('secret content');
    expect(JSON.stringify(call)).not.toContain('aisup-test'); // socket not exposed
  });
});
