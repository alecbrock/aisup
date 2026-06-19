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
      { matcher: '*', hooks: [{ type: 'http', url: `${base}/permission`, timeout: opts.permissionTimeoutS ?? 600, headers }] },
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
