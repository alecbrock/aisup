/** Shared worker-output redaction: blank any line that looks like it carries a credential. */
const SECRET_LINE =
  /(token|secret|api[_-]?key|password|authorization|bot_token|app_token|signing_secret)\s*[:=]/i;

/** Replace credential-bearing lines with `[redacted]` (used for persisted tails AND live streaming). */
export function redactTails(text: string): string {
  return text
    .split('\n')
    .map((l) => (SECRET_LINE.test(l) ? '[redacted]' : l))
    .join('\n');
}
