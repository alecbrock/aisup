import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import type { CodexBudgetConfig } from '../config/schema.js';

/**
 * Per-account usage ledger.
 *
 * Providers expose no uniform "remaining quota" API, and the statusline tap is only fresh while a
 * session is actively rendering. The ledger turns the three signals we CAN trust — exact usage while
 * active, deterministic rolling-window resets, and reactive errors — into a best-estimate of every
 * account's headroom even when idle: capture live usage + reset times, then **decay a window to 0%
 * once its reset_at has passed** (a rolling window provably resets; an idle account accrues nothing).
 */

export type WindowBasis = 'live' | 'aged' | 'reset' | 'unknown';

/** A live observation of one rolling window. `reset_at` is Unix epoch SECONDS (matches the tap). */
export interface CaptureWindow {
  used_pct: number;
  reset_at: number;
}
export interface CaptureWindows {
  five_hour?: CaptureWindow;
  seven_day?: CaptureWindow;
}

export interface WindowEstimate {
  used_pct: number | null;
  basis: WindowBasis;
}
export interface AccountEstimate {
  five_hour: WindowEstimate;
  seven_day: WindowEstimate;
}

/** `captured_at` is Unix epoch MILLISECONDS (the moment the data was true). */
interface LedgerWindow {
  used_pct: number;
  reset_at: number;
  captured_at: number;
}
interface LedgerEntry {
  five_hour?: LedgerWindow;
  seven_day?: LedgerWindow;
}

/** A metered token budget for a provider (codex). `period_reset_at` is Unix epoch SECONDS. */
interface BudgetEntry {
  tokens_used: number;
  cap: number;
  period_reset_at: number;
}

export interface BudgetEstimate {
  tokens_used: number;
  cap: number;
  remaining: number;
  available: boolean;
}

const DEFAULT_FRESHNESS_MS = 5 * 60 * 1000;

export class UsageLedger {
  private readonly path: string;
  private readonly freshnessMs: number;
  private entries: Record<string, LedgerEntry>;
  private budgets: Record<string, BudgetEntry>;

  constructor(path: string, freshnessMs: number = DEFAULT_FRESHNESS_MS) {
    this.path = path;
    this.freshnessMs = freshnessMs;
    const loaded = this.load();
    this.entries = loaded.accounts;
    this.budgets = loaded.budgets;
  }

  private load(): { accounts: Record<string, LedgerEntry>; budgets: Record<string, BudgetEntry> } {
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as {
        accounts?: Record<string, LedgerEntry>;
        budgets?: Record<string, BudgetEntry>;
      };
      return { accounts: parsed.accounts ?? {}, budgets: parsed.budgets ?? {} };
    } catch {
      return { accounts: {}, budgets: {} };
    }
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    } catch {
      // best-effort; the write below will surface a real failure
    }
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ accounts: this.entries, budgets: this.budgets }, null, 2), { mode: 0o600 });
    renameSync(tmp, this.path);
  }

  /**
   * Add `tokens` to a provider's rolling budget meter. Starts a fresh period (tokens_used=0) when there
   * is no entry or the stored period has elapsed; `cap` is refreshed from the live config each call.
   */
  recordConsumption(provider: string, tokens: number, nowMs: number, cfg: CodexBudgetConfig): void {
    const nowS = Math.floor(nowMs / 1000);
    const existing = this.budgets[provider];
    const fresh = !existing || nowS >= existing.period_reset_at;
    const entry: BudgetEntry = fresh
      ? { tokens_used: 0, cap: cfg.tokens, period_reset_at: nowS + cfg.period_hours * 3600 }
      : { ...existing, cap: cfg.tokens };
    entry.tokens_used += tokens;
    this.budgets[provider] = entry;
    this.persist();
  }

  /**
   * Best-estimate budget state for a provider against the LIVE config cap (so a config change takes
   * effect immediately, not after the next run). `tokens_used` decays to 0 once the stored period elapses.
   */
  estimateBudget(provider: string, nowMs: number, cfg: CodexBudgetConfig): BudgetEstimate {
    const nowS = Math.floor(nowMs / 1000);
    const entry = this.budgets[provider];
    const used = !entry || nowS >= entry.period_reset_at ? 0 : entry.tokens_used;
    const cap = cfg.tokens;
    const remaining = Math.max(0, cap - used);
    return { tokens_used: used, cap, remaining, available: used < cap };
  }

  /** Record live usage for an account. Only the windows present are updated. */
  capture(account: string, windows: CaptureWindows, capturedAtMs: number): void {
    const entry: LedgerEntry = { ...this.entries[account] };
    if (windows.five_hour) {
      entry.five_hour = { used_pct: windows.five_hour.used_pct, reset_at: windows.five_hour.reset_at, captured_at: capturedAtMs };
    }
    if (windows.seven_day) {
      entry.seven_day = { used_pct: windows.seven_day.used_pct, reset_at: windows.seven_day.reset_at, captured_at: capturedAtMs };
    }
    this.entries[account] = entry;
    this.persist();
  }

  /** Best-estimate usage for an account, decayed by reset time and tagged with its basis. */
  estimate(account: string, nowMs: number): AccountEstimate {
    const entry = this.entries[account];
    return {
      five_hour: this.estimateWindow(entry?.five_hour, nowMs),
      seven_day: this.estimateWindow(entry?.seven_day, nowMs),
    };
  }

  private estimateWindow(w: LedgerWindow | undefined, nowMs: number): WindowEstimate {
    if (!w) return { used_pct: null, basis: 'unknown' };
    if (nowMs >= w.reset_at * 1000) return { used_pct: 0, basis: 'reset' }; // rolling window has reset
    if (nowMs - w.captured_at <= this.freshnessMs) return { used_pct: w.used_pct, basis: 'live' };
    return { used_pct: w.used_pct, basis: 'aged' };
  }
}
