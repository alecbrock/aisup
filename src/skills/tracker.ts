import { detectSkill } from './detector.js';

export type SkillTransitionCallback = (from: string | null, to: string) => void;

export class SkillTracker {
  private trackedSkills: string[];
  private onTransition: SkillTransitionCallback | undefined;
  activeSkill: string | null = null;

  constructor(trackedSkills: string[], onTransition?: SkillTransitionCallback) {
    this.trackedSkills = trackedSkills;
    this.onTransition = onTransition;
  }

  processOutput(output: string): void {
    const detected = detectSkill(output, this.trackedSkills);
    if (detected && detected !== this.activeSkill) {
      const prev = this.activeSkill;
      this.activeSkill = detected;
      this.onTransition?.(prev, detected);
    }
  }

  reset(): void {
    this.activeSkill = null;
  }
}
