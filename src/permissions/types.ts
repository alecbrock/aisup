/** A permission request extracted from runner output, fed to the policy engine. */
export interface PermissionRequest {
  /** Tool name (e.g. "Bash", "Edit") or "unknown" for generic confirmations. */
  tool: string;
  /** The action detail (command, path, or prompt text), used for policy matching. */
  detail: string;
  /** The matched prompt line, ANSI-stripped and length-bounded, for observability. */
  raw: string;
}
