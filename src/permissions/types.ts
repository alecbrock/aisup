/** A permission request extracted from runner output, fed to the policy engine. */
export interface PermissionRequest {
  /** Tool name (e.g. "Bash", "Edit") or "unknown" for generic confirmations. */
  tool: string;
  /** The action detail (command, path, or prompt text), used for policy matching. */
  detail: string;
  /** The matched prompt line, ANSI-stripped and length-bounded, for observability. */
  raw: string;
  /** Opaque id (uuid) the interactive Slack card and queue entry are keyed by. Set at hook time so
   *  out-of-order button taps resolve the correct request (`resolveById`). Absent on the legacy
   *  detector/scrape path, which resolves FIFO by session. */
  request_id?: string;
}
