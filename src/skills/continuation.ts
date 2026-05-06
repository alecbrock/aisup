export interface ContinuationOpts {
  activeSkill: string | null;
  planPath: string | null;
  template?: string;
}

const DEFAULT_TEMPLATE =
  'Continue the current session. You were running {skill}. Plan file: {plan_path}. Resume from the next uncompleted task.';

/** Build continuation prompt (only used when resume_prompt_mode is not "never"). */
export function buildContinuationPrompt(opts: ContinuationOpts): string {
  const template = opts.template ?? DEFAULT_TEMPLATE;
  return template
    .replace('{skill}', opts.activeSkill ?? 'unknown skill')
    .replace('{plan_path}', opts.planPath ?? 'not specified');
}
