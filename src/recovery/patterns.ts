import stripAnsi from 'strip-ansi';

/**
 * Auth-failure signatures in Claude/runner pane output. Kept precise to avoid
 * false positives on ordinary prose (e.g. "authorized", a bare "401" in test
 * counts) — an auth failure escalates straight to an account switch.
 */
const AUTH_FAILURE_PATTERNS = [
  /authentication\s+(failed|error|required)/i,
  /invalid\s+api[\s_-]?key/i,
  /\bunauthorized\b/i,
  /oauth\b[^\n]{0,40}(expired|invalid|revoked)/i,
  /\binvalid\s+(bearer\s+)?token\b/i,
  /please\s+(run\s+)?\/login/i,
];

/**
 * Transient network-failure signatures. These escalate to a same-account
 * restart only after the configured threshold, since a single blip recovers.
 */
const NETWORK_ERROR_PATTERNS = [
  /\b(ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|EHOSTUNREACH|ENETUNREACH)\b/,
  /network\s+error/i,
  /connection\s+(refused|reset|timed?\s*out|closed)/i,
  /fetch\s+failed/i,
  /socket\s+hang\s?up/i,
  /request\s+timed?\s*out/i,
];

/** True when the (ANSI-stripped) output contains an auth-failure signature. */
export function detectAuthFailure(text: string): boolean {
  const clean = stripAnsi(text);
  return AUTH_FAILURE_PATTERNS.some((p) => p.test(clean));
}

/** True when the (ANSI-stripped) output contains a network-error signature. */
export function detectNetworkError(text: string): boolean {
  const clean = stripAnsi(text);
  return NETWORK_ERROR_PATTERNS.some((p) => p.test(clean));
}
