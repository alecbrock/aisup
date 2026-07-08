export enum SwitchReason {
  SoftThreshold = 'soft_threshold',
  HardThreshold = 'hard_threshold',
  RateLimit429 = '429',
  ProcessCrash = 'process_crash',
  RestartFailures = 'restart_failures',
  CircuitBreaker = 'circuit_breaker',
  Manual = 'manual',
  SourceDead = 'source_dead',
  AuthFailure = 'auth_failure',
  NetworkError = 'network_error',
}

/** Per-candidate line of a failover selection: its score and why it was (not) chosen. */
export interface CandidateRationale {
  name: string;
  score: number | null;
  /** null when the candidate was eligible; otherwise why it was passed over. */
  excluded_reason:
    | 'is_current'
    | 'already_tried'
    | 'disabled'
    | 'excluded'
    | 'cooldown'
    | 'unavailable'
    | 'below_current_score'
    | null;
}

/** The "why" behind a failover: the trigger, every candidate's score + disposition, and the winner. */
export interface SelectionRationale {
  reason_code: SwitchReason | null;
  candidates: CandidateRationale[];
  chosen: string | null;
}

export interface SwitchSnapshot {
  aisupSessionId: string;
  claudeSessionId: string | null;
  transcriptPath: string | null;
  activeSkill: string | null;
  planFilePath: string | null;
  sourceAccount: string;
  targetAccount: string;
  reason: SwitchReason;
  selectionMode: 'automatic' | 'manual';
  /** Explainability payload persisted on the account.switch event (C2). Optional for back-compat. */
  rationale?: SelectionRationale;
}

export interface ValidationResult {
  valid: boolean;
  reason?: string;
  warning?: string;
}
