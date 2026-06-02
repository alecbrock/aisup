import { writeFileSync, readFileSync, existsSync } from 'node:fs';

export type CBState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

interface AccountCBRecord {
  failures: number;
  state: CBState;
  openedAt?: string;
}

type CBStore = Record<string, AccountCBRecord>;

interface CircuitBreakerOpts {
  maxFailures: number;
  cooldownSeconds: number;
  statePath: string;
}

export class CircuitBreaker {
  private maxFailures: number;
  private cooldownMs: number;
  private statePath: string;
  private store: CBStore;

  constructor(opts: CircuitBreakerOpts) {
    this.maxFailures = opts.maxFailures;
    this.cooldownMs = opts.cooldownSeconds * 1000;
    this.statePath = opts.statePath;
    this.store = this.load();
  }

  private load(): CBStore {
    if (!existsSync(this.statePath)) return {};
    try {
      const raw = JSON.parse(readFileSync(this.statePath, 'utf8')) as CBStore;
      // Recover stale entries on load — OPEN past cooldown → HALF_OPEN
      const now = Date.now();
      for (const [, rec] of Object.entries(raw)) {
        if (rec.state === 'OPEN' && rec.openedAt) {
          const openedMs = new Date(rec.openedAt).getTime();
          if (now - openedMs >= this.cooldownMs) {
            rec.state = 'HALF_OPEN';
          }
        }
      }
      return raw;
    } catch {
      return {};
    }
  }

  private save(): void {
    try {
      writeFileSync(this.statePath, JSON.stringify(this.store, null, 2), { mode: 0o600 });
    } catch {
      // best-effort persistence
    }
  }

  private record(name: string): AccountCBRecord {
    if (!this.store[name]) {
      this.store[name] = { failures: 0, state: 'CLOSED' };
    }
    return this.store[name];
  }

  getState(name: string): CBState {
    const rec = this.store[name];
    if (!rec) return 'CLOSED';

    if (rec.state === 'OPEN' && rec.openedAt) {
      const elapsed = Date.now() - new Date(rec.openedAt).getTime();
      if (elapsed >= this.cooldownMs) {
        rec.state = 'HALF_OPEN';
        this.save();
      }
    }

    return rec.state;
  }

  recordFailure(name: string): void {
    const rec = this.record(name);
    rec.failures += 1;

    if (rec.state === 'HALF_OPEN' || rec.failures >= this.maxFailures) {
      rec.state = 'OPEN';
      rec.openedAt = new Date().toISOString();
    }

    this.save();
  }

  recordSuccess(name: string): void {
    const rec = this.record(name);
    rec.failures = 0;
    rec.state = 'CLOSED';
    delete rec.openedAt;
    this.save();
  }

  getCooldownEta(name: string): Date | null {
    const rec = this.store[name];
    if (!rec || rec.state !== 'OPEN' || !rec.openedAt) return null;
    return new Date(new Date(rec.openedAt).getTime() + this.cooldownMs);
  }

  /** Test helper: backdate the trip time to simulate cooldown expiry. */
  overrideTripTime(name: string, at: Date): void {
    const rec = this.record(name);
    rec.openedAt = at.toISOString();
    this.save();
  }
}
