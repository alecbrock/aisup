import { epochSecondsToDate } from '../../statusline/store.js';

interface RateLimitData {
  five_hour?: { used_percentage: number; resets_at: number };
  seven_day?: { used_percentage: number; resets_at: number };
}

export interface ThresholdCheckResult {
  level: 'none' | 'soft' | 'hard';
  triggeredWindow?: 'five_hour' | 'seven_day';
  fiveHourPct?: number;
  sevenDayPct?: number;
  resetsAt?: Date;
}

export interface RateLimitMonitorOpts {
  intervalMs: number;
  onThresholdBreach: (result: ThresholdCheckResult) => void;
}

export class RateLimitMonitor {
  private intervalMs: number;
  private onBreach: (result: ThresholdCheckResult) => void;
  private handle: ReturnType<typeof setInterval> | null = null;

  constructor(opts: RateLimitMonitorOpts) {
    this.intervalMs = opts.intervalMs;
    this.onBreach = opts.onThresholdBreach;
  }

  static checkThresholds(
    rateLimits: RateLimitData | undefined,
    softPct: number,
    hardPct: number
  ): ThresholdCheckResult {
    if (!rateLimits?.five_hour || !rateLimits?.seven_day) {
      return { level: 'none' };
    }

    const fivePct = rateLimits.five_hour.used_percentage;
    const sevenPct = rateLimits.seven_day.used_percentage;
    const fiveReset = rateLimits.five_hour.resets_at;
    const sevenReset = rateLimits.seven_day.resets_at;

    // Hard threshold check (either window)
    if (fivePct >= hardPct || sevenPct >= hardPct) {
      const triggeredWindow: 'five_hour' | 'seven_day' = fivePct >= hardPct ? 'five_hour' : 'seven_day';
      const blockingReset = triggeredWindow === 'five_hour' ? fiveReset : sevenReset;
      return {
        level: 'hard',
        triggeredWindow,
        fiveHourPct: fivePct,
        sevenDayPct: sevenPct,
        resetsAt: epochSecondsToDate(blockingReset),
      };
    }

    // Soft threshold check (either window)
    if (fivePct >= softPct || sevenPct >= softPct) {
      const triggeredWindow: 'five_hour' | 'seven_day' = fivePct >= softPct ? 'five_hour' : 'seven_day';
      const blockingReset = triggeredWindow === 'five_hour' ? fiveReset : sevenReset;
      return {
        level: 'soft',
        triggeredWindow,
        fiveHourPct: fivePct,
        sevenDayPct: sevenPct,
        resetsAt: epochSecondsToDate(blockingReset),
      };
    }

    return { level: 'none', fiveHourPct: fivePct, sevenDayPct: sevenPct };
  }

  start(tickFn?: () => void): void {
    if (this.handle) return;
    this.handle = setInterval(() => {
      if (tickFn) tickFn();
    }, this.intervalMs);
  }

  stop(): void {
    if (this.handle) {
      clearInterval(this.handle);
      this.handle = null;
    }
  }

  tick(rateLimits: RateLimitData | undefined, softPct: number, hardPct: number): ThresholdCheckResult {
    const result = RateLimitMonitor.checkThresholds(rateLimits, softPct, hardPct);
    if (result.level !== 'none') {
      this.onBreach(result);
    }
    return result;
  }
}
