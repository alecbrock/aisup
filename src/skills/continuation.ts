export interface ContinuationOpts {
  activeSkill: string | null;
  planPath: string | null;
  template?: string;
}

/** Build continuation prompt (only used when resume_prompt_mode is not "never"). */
export function buildContinuationPrompt(opts: ContinuationOpts): string {
  // Custom template keeps the simple placeholder replacement (back-compat).
  if (opts.template) {
    return opts.template
      .replace('{skill}', opts.activeSkill ?? 'unknown skill')
      .replace('{plan_path}', opts.planPath ?? 'not specified');
  }
  // Default: build from whatever is known, omitting absent parts — no "unknown skill" / "not specified".
  const parts = ['Continue the current session.'];
  if (opts.activeSkill && opts.planPath) {
    parts.push(`You were running ${opts.activeSkill} (plan: ${opts.planPath}).`);
  } else if (opts.activeSkill) {
    parts.push(`You were running ${opts.activeSkill}.`);
  } else if (opts.planPath) {
    parts.push(`Plan file: ${opts.planPath}.`);
  }
  parts.push('Resume from the next uncompleted task.');
  return parts.join(' ');
}
