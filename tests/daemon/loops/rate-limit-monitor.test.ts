import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RateLimitMonitor, ThresholdCheckResult } from '../../../src/daemon/loops/rate-limit-monitor.js';

const SOFT = 85;
const HARD = 95;

function makeTelemetry(fivePct: number, sevenPct: number, futureReset = true) {
  const resets_at = futureReset ? Math.floor(Date.now() / 1000) + 3600 : Math.floor(Date.now() / 1000) - 3600;
  return {
    five_hour: { used_percentage: fivePct, resets_at },
    seven_day: { used_percentage: sevenPct, resets_at },
  };
}

describe('RateLimitMonitor.checkThresholds', () => {
  it('should return none when both windows are below soft threshold', () => {
    const result = RateLimitMonitor.checkThresholds(makeTelemetry(50, 60), SOFT, HARD);
    expect(result.level).toBe('none');
  });

  it('should return soft when five-hour reaches soft threshold', () => {
    const result = RateLimitMonitor.checkThresholds(makeTelemetry(85, 60), SOFT, HARD);
    expect(result.level).toBe('soft');
    expect(result.triggeredWindow).toBe('five_hour');
  });

  it('should return soft when seven-day alone reaches soft threshold', () => {
    const result = RateLimitMonitor.checkThresholds(makeTelemetry(50, 85), SOFT, HARD);
    expect(result.level).toBe('soft');
    expect(result.triggeredWindow).toBe('seven_day');
  });

  it('should return hard when five-hour reaches hard threshold', () => {
    const result = RateLimitMonitor.checkThresholds(makeTelemetry(95, 60), SOFT, HARD);
    expect(result.level).toBe('hard');
    expect(result.triggeredWindow).toBe('five_hour');
  });

  it('should return hard when seven-day alone reaches hard threshold', () => {
    const result = RateLimitMonitor.checkThresholds(makeTelemetry(50, 95), SOFT, HARD);
    expect(result.level).toBe('hard');
    expect(result.triggeredWindow).toBe('seven_day');
  });

  it('should prioritize hard over soft when both windows breach different levels', () => {
    const result = RateLimitMonitor.checkThresholds(makeTelemetry(95, 85), SOFT, HARD);
    expect(result.level).toBe('hard');
  });

  it('should include both window percentages in result', () => {
    const result = RateLimitMonitor.checkThresholds(makeTelemetry(90, 75), SOFT, HARD);
    expect(result.fiveHourPct).toBe(90);
    expect(result.sevenDayPct).toBe(75);
  });

  it('should include resets_at in result', () => {
    const result = RateLimitMonitor.checkThresholds(makeTelemetry(90, 75), SOFT, HARD);
    expect(result.resetsAt).toBeDefined();
    expect(result.resetsAt).toBeInstanceOf(Date);
  });

  it('should return none when rate_limits is missing', () => {
    const result = RateLimitMonitor.checkThresholds(undefined, SOFT, HARD);
    expect(result.level).toBe('none');
  });
});

describe('RateLimitMonitor loop', () => {
  it('should start and stop cleanly', () => {
    const monitor = new RateLimitMonitor({
      intervalMs: 1000,
      onThresholdBreach: vi.fn(),
    });
    monitor.start();
    monitor.stop();
    // No exception = clean lifecycle
  });

  it('should not leak intervals after stop', () => {
    const onBreach = vi.fn();
    const monitor = new RateLimitMonitor({ intervalMs: 50, onThresholdBreach: onBreach });
    monitor.start();
    monitor.stop();
    // Callback should not be called after stop
    return new Promise<void>((resolve) => setTimeout(() => {
      expect(onBreach).not.toHaveBeenCalled();
      resolve();
    }, 150));
  });
});
