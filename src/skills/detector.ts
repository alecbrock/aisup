// Maps skill launch prefixes to tracked skill names
const SKILL_PREFIX_MAP: Record<string, string> = {
  'spec': '/spec',
  'prd': '/prd',
  'fix': '/fix',
  'review': '/review',
  'security-review': '/security-review',
};

const LAUNCH_PATTERN = /Launching skill:\s+(\S+)/g;

/**
 * Resolve a tracked skill from a Claude Code `UserPromptExpansion` hook's `command_name`
 * (e.g. `"prd"`, `"spec-plan"`). Structured, version-stable replacement for scraping a
 * `Launching skill:` marker out of pane output (which Claude Code 2.1.181 no longer emits).
 * Returns the tracked skill (e.g. `"/spec"`) or null when the command is not a tracked skill.
 */
export function resolveSkillFromCommandName(commandName: string, trackedSkills: string[]): string | null {
  const raw = commandName.trim().replace(/^\//, '');
  const trackedSet = new Set(trackedSkills);
  for (const [prefix, skill] of Object.entries(SKILL_PREFIX_MAP)) {
    if ((raw === prefix || raw.startsWith(`${prefix}-`)) && trackedSet.has(skill)) {
      return skill;
    }
  }
  return null;
}

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
