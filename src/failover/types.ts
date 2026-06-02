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
}

export interface ValidationResult {
  valid: boolean;
  reason?: string;
  warning?: string;
}
