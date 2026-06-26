import { join } from 'node:path';
import { homedir } from 'node:os';

/**
 * Root of the aisup state directory — config, pid, journal, ledger, sessions, channel-map,
 * hooks settings, logs, and the worker store all live under it. Defaults to `~/.aisup`;
 * setting `AISUP_HOME` relocates the ENTIRE state dir, which is the isolation primitive the
 * live multi-provider validation depends on (it runs a real daemon fully isolated from the
 * operator's `~/.aisup`).
 *
 * The env is read on EVERY call (no cached module const) so unit tests can flip `AISUP_HOME`.
 * NOTE: module-level path consts in the daemon/CLI that call this at import time capture the
 * value at process start — that is correct, because the live run sets `AISUP_HOME` before the
 * process launches. An empty `AISUP_HOME` is treated as unset (falls back to `~/.aisup`).
 *
 * ⛔ Account `config_dir`s, `HOME`, and `statusline.directory` are intentionally NOT relocated:
 * the first two resolve real Claude auth; the last is shared statusline-tap telemetry input.
 */
export function aisupHome(): string {
  const h = process.env.AISUP_HOME;
  return h && h.length > 0 ? h : join(homedir(), '.aisup');
}
