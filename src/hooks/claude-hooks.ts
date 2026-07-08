import { writeFileSync } from 'node:fs';

/**
 * Builds the aisup-managed Claude Code hook settings file. Loaded into every supervised session via
 * `claude --settings ~/.aisup/claude-hooks.json` (additive — no edits to the user's account or repo
 * settings). The hooks POST structured event payloads to the daemon's local API, replacing the
 * brittle pane-output scraping for skills (`UserPromptExpansion`) and permissions (`PermissionRequest`).
 * The bearer token is embedded literally (file is written 0600, same trust level as ~/.aisup/api-token).
 */

export interface HookSettingsOpts {
  port: number;
  token: string;
  host?: string;
  /** Install the UserPromptExpansion → /api/hooks/skill hook (skill detection, fire-and-forget). */
  includeSkill: boolean;
  /** Install the PermissionRequest → /api/hooks/permission hook (broker, blocks for Slack decision). */
  includePermission: boolean;
  /** Install the PostToolUse → /api/hooks/activity hook (live activity feed; fire-and-forget). */
  includeActivity?: boolean;
  /** Seconds the permission hook blocks awaiting a Slack decision before Claude's own dialog resumes. */
  permissionTimeoutS?: number;
}

interface HttpHook {
  type: 'http';
  url: string;
  timeout: number;
  headers: Record<string, string>;
}

interface MatcherGroup {
  matcher: string;
  hooks: HttpHook[];
}

export interface HookSettings {
  hooks: Record<string, MatcherGroup[]>;
}

/** Build the hook settings object (pure — for tests and writeHookSettings). */
export function buildHookSettings(opts: HookSettingsOpts): HookSettings {
  const host = opts.host ?? '127.0.0.1';
  const base = `http://${host}:${opts.port}/api/hooks`;
  const headers = { Authorization: `Bearer ${opts.token}` };
  const hooks: Record<string, MatcherGroup[]> = {};

  if (opts.includeSkill) {
    hooks.UserPromptExpansion = [
      { matcher: '*', hooks: [{ type: 'http', url: `${base}/skill`, timeout: 10, headers }] },
    ];
  }
  if (opts.includePermission) {
    hooks.PermissionRequest = [
      // Default 30s matches the daemon's intent ("short is plenty"): the hook is a non-blocking
      // detector that returns in ms; the human decision is resolved later via a keystroke (AF-310).
      { matcher: '*', hooks: [{ type: 'http', url: `${base}/permission`, timeout: opts.permissionTimeoutS ?? 30, headers }] },
    ];
  }
  if (opts.includeActivity) {
    // A4 SOURCE-PATH DECISION: hook-primary. PostToolUse → the activity feed is the SHIPPED source —
    // it uses the same proven HTTP-hook transport as PermissionRequest above and PostToolUse is a
    // standard Claude Code event. The transcript-`.jsonl`-tail path is the documented FOLLOW-UP
    // resilience add (read the active session's transcript tail on the relay tick), not shipped here.
    // Fire-and-forget (short timeout): the daemon returns immediately and posts to Slack out-of-band,
    // so a slow Slack call never stalls the session.
    hooks.PostToolUse = [
      { matcher: '*', hooks: [{ type: 'http', url: `${base}/activity`, timeout: 5, headers }] },
    ];
  }
  return { hooks };
}

/** Write the hook settings file (0600). Returns the JSON string written. */
export function writeHookSettings(filePath: string, opts: HookSettingsOpts): string {
  const json = JSON.stringify(buildHookSettings(opts), null, 2);
  writeFileSync(filePath, json, { mode: 0o600 });
  return json;
}
