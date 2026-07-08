/**
 * Per-account band tracker for proactive threshold/budget alerts (A8). The daemon already journals
 * `rate_limit.threshold_crossed` on every soft/hard tick — the gap is DELIVERY. This collapses the
 * per-tick stream into at most one Slack push per upward band crossing, and adds an optional early
 * `warning` band below soft. A drop back below a band re-arms it, so a later re-crossing alerts again.
 */

export type Band = 'none' | 'warning' | 'soft' | 'hard';

const RANK: Record<Band, number> = { none: 0, warning: 1, soft: 2, hard: 3 };

export interface ThresholdAlert {
  account: string;
  band: Exclude<Band, 'none'>;
  five_hour_pct: number | null;
  seven_day_pct: number | null;
  reset_eta: string | null;
}

export interface ThresholdAlerterDeps {
  /** Early-warning band threshold (%); absent = no warning band. */
  warningPct?: number;
  /** Deliver a (de-duped) alert. */
  notify: (alert: ThresholdAlert) => void;
}

export interface ThresholdTick {
  account: string;
  level: 'none' | 'soft' | 'hard';
  fiveHourPct: number | null;
  sevenDayPct: number | null;
  resetEta: string | null;
}

export class ThresholdAlerter {
  private lastBand = new Map<string, Band>();

  constructor(private deps: ThresholdAlerterDeps) {}

  /** Process one tick's threshold result for an account; pushes at most one alert per upward crossing. */
  onResult(tick: ThresholdTick): void {
    const band = this.bandFor(tick);
    const prev = this.lastBand.get(tick.account) ?? 'none';
    if (RANK[band] > RANK[prev]) {
      this.lastBand.set(tick.account, band);
      if (band !== 'none') {
        this.deps.notify({
          account: tick.account,
          band,
          five_hour_pct: tick.fiveHourPct,
          seven_day_pct: tick.sevenDayPct,
          reset_eta: tick.resetEta,
        });
      }
    } else if (RANK[band] < RANK[prev]) {
      // De-escalate (usage dropped) so the next upward crossing re-alerts — no push on the way down.
      this.lastBand.set(tick.account, band);
    }
  }

  private bandFor(tick: ThresholdTick): Band {
    if (tick.level === 'hard') return 'hard';
    if (tick.level === 'soft') return 'soft';
    const max = Math.max(tick.fiveHourPct ?? 0, tick.sevenDayPct ?? 0);
    if (this.deps.warningPct != null && max >= this.deps.warningPct) return 'warning';
    return 'none';
  }
}
