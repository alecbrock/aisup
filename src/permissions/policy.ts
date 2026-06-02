import picomatch from 'picomatch';
import type { PermissionPolicyConfig } from '../config/schema.js';
import type { PermissionRequest } from './types.js';

export type PermissionDecision = 'grant' | 'deny' | 'ask';

/** picomatch match guarded against malformed globs (a bad pattern never matches, never throws). */
function safeMatch(target: string, glob: string): boolean {
  try {
    return picomatch.isMatch(target, glob);
  } catch {
    return false;
  }
}

/**
 * Pure permission decision. Matches `<tool>:<detail>` against the policy globs (picomatch
 * semantics: `*` is bounded by path separators, `**` crosses them). Denylist wins over
 * allowlist. Unmatched requests fall back to `default_action`: `allow` → grant, `deny` → ask
 * (the broker resolves an `ask` via Slack routing, or a hard deny when routing is off).
 * No side effects — never sends tmux keystrokes.
 */
export function evaluatePermission(
  request: PermissionRequest,
  policy: PermissionPolicyConfig
): PermissionDecision {
  const target = `${request.tool}:${request.detail}`;
  const denylist = Array.isArray(policy.denylist) ? policy.denylist : [];
  const allowlist = Array.isArray(policy.allowlist) ? policy.allowlist : [];

  if (denylist.some((glob) => safeMatch(target, glob))) return 'deny';
  if (allowlist.some((glob) => safeMatch(target, glob))) return 'grant';
  return policy.default_action === 'allow' ? 'grant' : 'ask';
}
