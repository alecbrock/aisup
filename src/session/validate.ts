import type { SessionState } from './types.js';

/**
 * Runtime shape guard for externally-written `state.json` (AF-312/AF-313). Returns true only for a
 * non-null object whose core identity fields are strings — enough to reject corrupt/wrong-shape
 * JSON ({}, [], 42, {field: <wrong type>}) before it is type-asserted and crashes a consumer.
 */
export function isValidSessionState(v: unknown): v is SessionState {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.aisup_session_id === 'string' &&
    typeof o.status === 'string' &&
    typeof o.account === 'string' &&
    typeof o.tmux_name === 'string'
  );
}
