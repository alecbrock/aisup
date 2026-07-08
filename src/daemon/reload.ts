import type { AisupConfig } from '../config/schema.js';

/**
 * C13 hot-reload classification. Given the old and freshly-read config, decide which changed keys
 * are safe to apply to a running daemon (thresholds, verbosity, allowed users, account list) and
 * which changed keys are structural and need a full restart (port, journal path, statusline dir,
 * Slack enable toggle, monitoring interval timers).
 */
export interface ReloadPlan {
  applied: string[];
  restart_required: string[];
}

interface KeySpec { key: string; get: (c: AisupConfig) => unknown }

const HOT: KeySpec[] = [
  { key: 'thresholds.soft_pct', get: (c) => c.thresholds.soft_pct },
  { key: 'thresholds.hard_pct', get: (c) => c.thresholds.hard_pct },
  { key: 'thresholds.idle_boundary_seconds', get: (c) => c.thresholds.idle_boundary_seconds },
  { key: 'notifications.verbosity', get: (c) => c.notifications.verbosity },
  { key: 'slack.allowed_user_ids', get: (c) => c.slack.allowed_user_ids },
  { key: 'accounts', get: (c) => c.accounts },
];

const RESTART: KeySpec[] = [
  { key: 'daemon.port', get: (c) => c.daemon.port },
  { key: 'journal.path', get: (c) => c.journal.path },
  { key: 'statusline.directory', get: (c) => c.statusline.directory },
  { key: 'slack.enabled', get: (c) => c.slack.enabled },
  { key: 'monitoring', get: (c) => c.monitoring }, // interval timers can't re-arm live → restart
];

/** Classify config changes into hot-applied vs restart-required (unchanged keys appear in neither). */
export function planReload(oldCfg: AisupConfig, next: AisupConfig): ReloadPlan {
  const changed = (s: KeySpec): boolean => JSON.stringify(s.get(oldCfg)) !== JSON.stringify(s.get(next));
  return {
    applied: HOT.filter(changed).map((s) => s.key),
    restart_required: RESTART.filter(changed).map((s) => s.key),
  };
}
