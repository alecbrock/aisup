import { RateLimitMonitor } from './loops/rate-limit-monitor.js';
import { RecoveryHandler } from './loops/recovery-handler.js';
import { HealthChecker } from './loops/health-checker.js';
import { IdleWatchdog } from './loops/idle-watchdog.js';

export interface LoopManagerOpts {
  rateLimitIntervalMs: number;
  healthIntervalMs: number;
  recoveryIntervalMs: number;
  idleIntervalMs: number;
  onThresholdBreach: ConstructorParameters<typeof RateLimitMonitor>[0]['onThresholdBreach'];
  onCrashDetected: ConstructorParameters<typeof RecoveryHandler>[0]['onCrashDetected'];
  onHealthResult: ConstructorParameters<typeof HealthChecker>[0]['onResult'];
  onIdle: ConstructorParameters<typeof IdleWatchdog>[0]['onIdle'];
}

export class LoopManager {
  rateLimitMonitor: RateLimitMonitor;
  recoveryHandler: RecoveryHandler;
  healthChecker: HealthChecker;
  idleWatchdog: IdleWatchdog;

  constructor(opts: LoopManagerOpts) {
    this.rateLimitMonitor = new RateLimitMonitor({
      intervalMs: opts.rateLimitIntervalMs,
      onThresholdBreach: opts.onThresholdBreach,
    });
    this.recoveryHandler = new RecoveryHandler({
      intervalMs: opts.recoveryIntervalMs,
      onCrashDetected: opts.onCrashDetected,
    });
    this.healthChecker = new HealthChecker({
      intervalMs: opts.healthIntervalMs,
      onResult: opts.onHealthResult,
    });
    this.idleWatchdog = new IdleWatchdog({
      intervalMs: opts.idleIntervalMs,
      onIdle: opts.onIdle,
    });
  }

  startAll(): void {
    this.rateLimitMonitor.start();
    this.recoveryHandler.start();
    this.healthChecker.start();
    this.idleWatchdog.start();
  }

  stopAll(): void {
    this.rateLimitMonitor.stop();
    this.recoveryHandler.stop();
    this.healthChecker.stop();
    this.idleWatchdog.stop();
  }
}
