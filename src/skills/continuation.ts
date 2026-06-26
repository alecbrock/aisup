export interface ContinuationOpts {
  activeSkill: string | null;
  planPath: string | null;
}

/**
 * Strip newlines/control chars (and collapse runs of whitespace) from a substituted field so a
 * crafted `active_skill` / `plan_path` cannot inject extra prompt lines or instructions into the
 * resumed prompt (AF-326). `active_skill` originates from external telemetry / detected output, so
 * it is untrusted input to the prompt builder.
 */
function sanitizeField(v: string): string {
  return v.replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

/** Build continuation prompt (only used when resume_prompt_mode is not "never"). */
export function buildContinuationPrompt(opts: ContinuationOpts): string {
  const skill = opts.activeSkill ? sanitizeField(opts.activeSkill) : null;
  const plan = opts.planPath ? sanitizeField(opts.planPath) : null;
  // Build from whatever is known, omitting absent parts — no "unknown skill" / "not specified".
  const parts = ['Continue the current session.'];
  if (skill && plan) {
    parts.push(`You were running ${skill} (plan: ${plan}).`);
  } else if (skill) {
    parts.push(`You were running ${skill}.`);
  } else if (plan) {
    parts.push(`Plan file: ${plan}.`);
  }
  parts.push('Resume from the next uncompleted task.');
  return parts.join(' ');
}
