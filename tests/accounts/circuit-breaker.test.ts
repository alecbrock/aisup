import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CircuitBreaker } from '../../src/accounts/circuit-breaker.js';

describe('CircuitBreaker', () => {
  let tmpDir: string;
  let statePath: string;
  let cb: CircuitBreaker;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'aisup-cb-'));
    statePath = join(tmpDir, 'circuit-breaker-state.json');
    cb = new CircuitBreaker({ maxFailures: 3, cooldownSeconds: 60, statePath });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should start in CLOSED (healthy) state', () => {
    expect(cb.getState('primary')).toBe('CLOSED');
  });

  it('should remain CLOSED after failures below threshold', () => {
    cb.recordFailure('primary');
    cb.recordFailure('primary');
    expect(cb.getState('primary')).toBe('CLOSED');
  });

  it('should trip to OPEN after max_failures consecutive failures', () => {
    cb.recordFailure('primary');
    cb.recordFailure('primary');
    cb.recordFailure('primary');
    expect(cb.getState('primary')).toBe('OPEN');
  });

  it('should reset failure count on success', () => {
    cb.recordFailure('primary');
    cb.recordFailure('primary');
    cb.recordSuccess('primary');
    cb.recordFailure('primary');
    expect(cb.getState('primary')).toBe('CLOSED');
  });

  it('should transition to HALF_OPEN after cooldown expires', () => {
    cb.recordFailure('primary');
    cb.recordFailure('primary');
    cb.recordFailure('primary');
    // Simulate cooldown expiry by backdating the trip time
    cb.overrideTripTime('primary', new Date(Date.now() - 61000));
    expect(cb.getState('primary')).toBe('HALF_OPEN');
  });

  it('should reset to CLOSED on success from HALF_OPEN', () => {
    cb.recordFailure('primary');
    cb.recordFailure('primary');
    cb.recordFailure('primary');
    cb.overrideTripTime('primary', new Date(Date.now() - 61000));
    expect(cb.getState('primary')).toBe('HALF_OPEN');
    cb.recordSuccess('primary');
    expect(cb.getState('primary')).toBe('CLOSED');
  });

  it('should return to OPEN on failure from HALF_OPEN', () => {
    cb.recordFailure('primary');
    cb.recordFailure('primary');
    cb.recordFailure('primary');
    cb.overrideTripTime('primary', new Date(Date.now() - 61000));
    cb.recordFailure('primary');
    expect(cb.getState('primary')).toBe('OPEN');
  });

  it('should persist state to disk on change', () => {
    cb.recordFailure('primary');
    cb.recordFailure('primary');
    cb.recordFailure('primary');

    // Load fresh instance from same file
    const cb2 = new CircuitBreaker({ maxFailures: 3, cooldownSeconds: 60, statePath });
    expect(cb2.getState('primary')).toBe('OPEN');
  });

  it('should recover stale OPEN entries on load', () => {
    cb.recordFailure('primary');
    cb.recordFailure('primary');
    cb.recordFailure('primary');
    cb.overrideTripTime('primary', new Date(Date.now() - 61000));

    // Load fresh instance — stale OPEN should be HALF_OPEN
    const cb2 = new CircuitBreaker({ maxFailures: 3, cooldownSeconds: 60, statePath });
    expect(cb2.getState('primary')).toBe('HALF_OPEN');
  });

  it('should track multiple accounts independently', () => {
    cb.recordFailure('primary');
    cb.recordFailure('primary');
    cb.recordFailure('primary');
    expect(cb.getState('primary')).toBe('OPEN');
    expect(cb.getState('account2')).toBe('CLOSED');
  });

  it('should return cooldown ETA when OPEN', () => {
    cb.recordFailure('primary');
    cb.recordFailure('primary');
    cb.recordFailure('primary');
    const eta = cb.getCooldownEta('primary');
    expect(eta).toBeInstanceOf(Date);
    expect(eta!.getTime()).toBeGreaterThan(Date.now());
  });
});
