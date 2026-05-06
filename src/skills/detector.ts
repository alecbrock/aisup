// Maps skill launch prefixes to tracked skill names
const SKILL_PREFIX_MAP: Record<string, string> = {
  'spec': '/spec',
  'prd': '/prd',
  'fix': '/fix',
  'review': '/review',
  'security-review': '/security-review',
};

const LAUNCH_PATTERN = /Launching skill:\s+(\S+)/g;

/** Extract the tracked skill from output text, or null if none found. */
export function detectSkill(output: string, trackedSkills: string[]): string | null {
  const trackedSet = new Set(trackedSkills);
  let match: RegExpExecArray | null;
  let found: string | null = null;

  LAUNCH_PATTERN.lastIndex = 0;
  while ((match = LAUNCH_PATTERN.exec(output)) !== null) {
    const raw = match[1];
    // Find matching prefix (spec-plan → /spec, prd → /prd, etc.)
    for (const [prefix, skill] of Object.entries(SKILL_PREFIX_MAP)) {
      if (raw === prefix || raw.startsWith(`${prefix}-`)) {
        if (trackedSet.has(skill)) {
          found = skill; // latest wins — keep iterating
        }
        break;
      }
    }
  }

  return found;
}
