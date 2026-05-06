import type { AccountInfo } from '../accounts/types.js';
import type { ValidationResult } from './types.js';

/** Validate a manual failover target account. Returns valid=true or typed rejection reason. */
export function validateManualFailoverTarget(
  targetName: string,
  currentAccount: string,
  accounts: AccountInfo[]
): ValidationResult {
  const target = accounts.find((a) => a.name === targetName);

  if (!target) {
    return { valid: false, reason: `target_invalid: account "${targetName}" not found in config` };
  }

  if (targetName === currentAccount) {
    return { valid: false, reason: `target_is_current: "${targetName}" is already the active account` };
  }

  if (!target.enabled || target.state === 'UNAVAILABLE') {
    return {
      valid: false,
      reason: `target_unavailable: account "${targetName}" is ${!target.enabled ? 'disabled' : target.state}`,
    };
  }

  if (target.state === 'COOLDOWN') {
    return {
      valid: true,
      warning: `account "${targetName}" is in COOLDOWN — proceeding as manual override`,
    };
  }

  return { valid: true };
}
