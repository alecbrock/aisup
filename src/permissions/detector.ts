import stripAnsi from 'strip-ansi';
import type { PermissionRequest } from './types.js';

/** Tool names Claude surfaces in permission prompts; constrained to avoid prose false positives. */
const TOOL = 'Bash|Edit|Write|Read|MultiEdit|NotebookEdit|WebFetch|WebSearch|Task|Glob|Grep|Agent';

/**
 * Built-in permission-prompt patterns, used when `permissions.detection_patterns` is empty.
 * Patterns are line-oriented with optional `tool`/`detail` named groups. They are deliberately
 * specific (explicit tool alternation, full prompt phrasings) so ordinary prose containing
 * "allow" does not trigger a detection. The host-gated AISUP_TEST_PERMISSIONS path validates
 * these against real Claude prompts.
 */
export const DEFAULT_PERMISSION_PATTERNS: RegExp[] = [
  new RegExp(`\\ballow\\s+(?<tool>${TOOL})\\s+to\\s+(?<detail>.+?)\\s*\\?`, 'i'),
  new RegExp(`permission to (?:use|run)\\s+(?<tool>${TOOL})\\b[:\\s-]*(?<detail>.*)`, 'i'),
  new RegExp(`^\\s*(?<tool>${TOOL})\\b[^:\\n]*:\\s*(?<detail>.+\\S)\\s*$`, 'i'),
  // Verb set audited against real Claude 2.1.x prompts (AF-103): "create" was missing, so a live
  // "Do you want to create <file>?" never fired permission.detected. (Cursor-fragmentation of the
  // modal render is a separate, deeper detection-robustness issue tracked under the validation plan.)
  /(?:^|\s)(?<detail>do you want to (?:proceed|continue|make this edit|create|run this|delete|overwrite)\b[^?\n]*\??)/i,
];

const MAX_FIELD = 200;

/**
 * Scans runner output deltas for permission prompts. Stateful: dedupes a prompt that
 * persists across consecutive scans (terminal re-render) while still re-detecting a
 * genuinely new identical prompt after the previous one clears.
 */
export class PermissionDetector {
  private patterns: RegExp[];
  /** Signatures (`tool:detail`) present in the immediately preceding scan. */
  private lastSignatures = new Set<string>();

  constructor(configPatterns: string[]) {
    this.patterns = configPatterns.length > 0
      ? configPatterns.map((p) => new RegExp(p, 'i'))
      : DEFAULT_PERMISSION_PATTERNS;
  }

  /** Return permission requests newly detected in this delta (deduped vs the previous scan). */
  scan(delta: string): PermissionRequest[] {
    const clean = stripAnsi(delta);
    const current = new Map<string, PermissionRequest>();

    for (const line of clean.split('\n')) {
      for (const pattern of this.patterns) {
        const m = pattern.exec(line);
        if (!m) continue;
        const req = toRequest(m, line);
        current.set(`${req.tool}:${req.detail}`, req);
        break; // first matching pattern wins for this line
      }
    }

    const fresh: PermissionRequest[] = [];
    for (const [sig, req] of current) {
      if (!this.lastSignatures.has(sig)) fresh.push(req);
    }
    this.lastSignatures = new Set(current.keys());
    return fresh;
  }
}

function toRequest(m: RegExpExecArray, line: string): PermissionRequest {
  const tool = m.groups?.tool?.trim() || 'unknown';
  const detail = (m.groups?.detail ?? line).trim().slice(0, MAX_FIELD);
  return { tool, detail, raw: line.trim().slice(0, MAX_FIELD) };
}
