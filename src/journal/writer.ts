import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import { statSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import type { JournalEvent, JournalWriter, JournalAppendResult } from './types.js';

const SECRET_KEY_PATTERN = /^(.*_)?(token|secret|apikey|api_key|authorization|password|bot_token|app_token|signing_secret)$/i;

// Vendor-prefixed secret VALUES (AF-325): catch a secret stored under an innocuous key name. Each
// requires a non-token char (or start) before the prefix so normal prose ("task_id") never matches,
// plus a long body so short ids ("sk_1") don't false-positive.
const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /(?:^|[^A-Za-z0-9])gh[oprsu]_[A-Za-z0-9]{20,}/, // GitHub: ghp_/gho_/ghs_/ghr_/ghu_ + token body
  /(?:^|[^A-Za-z0-9])(?:sk|rk|pk)_[A-Za-z0-9_]{16,}/, // Stripe-style sk_/rk_/pk_ (incl. _live_/_test_)
  /(?:^|[^A-Za-z0-9])sk-[A-Za-z0-9-]{20,}/, // OpenAI-style sk- / sk-proj- keys
];

function isSecretValue(s: string): boolean {
  return SECRET_VALUE_PATTERNS.some((re) => re.test(s));
}

/** Returns a human-readable reason for the first forbidden secret (key OR value) in `details`, else null. */
function findForbiddenSecret(obj: unknown, path = 'details'): string | null {
  if (typeof obj === 'string') {
    return isSecretValue(obj) ? `forbidden secret value at ${path}` : null;
  }
  if (!obj || typeof obj !== 'object') return null;
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      const hit = findForbiddenSecret(obj[i], `${path}[${i}]`);
      if (hit) return hit;
    }
    return null;
  }
  for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
    if (SECRET_KEY_PATTERN.test(key)) return `forbidden secret key "${key}" at ${path}.${key}`;
    const hit = findForbiddenSecret(val, `${path}.${key}`);
    if (hit) return hit;
  }
  return null;
}

/**
 * Append a journal event. ⛔ NEVER throws (AF-301): the supervisor daemon must survive a journal
 * write/scan failure rather than crash from a fire-and-forget `void journal.append(...)` site. A
 * failure is returned as `{ok:false, reason}` and surfaced as a stderr health line (→ rotating
 * daemon log) — replacing both the old ENOSPC silent-swallow and the old non-ENOSPC/secret-scan
 * throw. A secret-bearing event is still NOT written (the security guarantee is preserved).
 */
export async function appendEvent(journalPath: string, event: JournalEvent): Promise<JournalAppendResult> {
  const fail = (reason: string): JournalAppendResult => {
    try {
      process.stderr.write(`[aisup] journal.write_failed (${event.event_type}): ${reason}\n`);
    } catch {
      /* the log sink itself is unavailable — nothing more we can safely do without recursing */
    }
    return { ok: false, reason };
  };

  const secretReason = findForbiddenSecret(event.details);
  if (secretReason) {
    return fail(secretReason);
  }

  try {
    const dir = dirname(journalPath);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const line = JSON.stringify(event) + '\n';
    await appendFile(journalPath, line, { encoding: 'utf8', mode: 0o600 });
    return { ok: true };
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    return fail(code === 'ENOSPC' ? 'disk full (ENOSPC)' : err instanceof Error ? err.message : String(err));
  }
}

/** D3: rotate the journal to `<path>.1` when it exceeds maxBytes, then journal the rotation. Best-effort. */
async function rotateJournalIfNeeded(journalPath: string, maxBytes: number): Promise<boolean> {
  try {
    const size = existsSync(journalPath) ? (await stat(journalPath)).size : 0;
    if (size <= maxBytes) return false;
    await rename(journalPath, `${journalPath}.1`);
    await appendEvent(journalPath, { ts: new Date().toISOString(), event_type: 'journal.rotated', details: { rotated_bytes: size } });
    return true;
  } catch {
    return false; // rotation is best-effort — never break journaling
  }
}

export function createJournalWriter(journalPath: string, maxSizeMb?: number): JournalWriter {
  const maxBytes = maxSizeMb && maxSizeMb > 0 ? maxSizeMb * 1024 * 1024 : Infinity;
  // Track bytes in-closure (like RotatingLog) so we don't stat() on every append.
  let bytes = 0;
  try { bytes = existsSync(journalPath) ? statSync(journalPath).size : 0; } catch { bytes = 0; }

  // The wrapper resolves to void and, because appendEvent never throws, NEVER rejects — so every
  // `void journal.append(...)` / `await journal.append(...)` call site is crash-safe (AF-301).
  return {
    append: async (event: JournalEvent): Promise<void> => {
      const res = await appendEvent(journalPath, event);
      if (res.ok && maxBytes !== Infinity) {
        bytes += Buffer.byteLength(JSON.stringify(event) + '\n');
        if (bytes > maxBytes) {
          if (await rotateJournalIfNeeded(journalPath, maxBytes)) bytes = 0;
        }
      }
    },
  };
}
