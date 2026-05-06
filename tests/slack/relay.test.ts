import { describe, it, expect } from 'vitest';
import { redactSecrets, isAllowedUser } from '../../src/slack/relay.js';

describe('redactSecrets', () => {
  it('should redact OpenAI-style secret keys', () => {
    const text = 'API key: sk-abcdefghijklmnopqrstu123456';
    expect(redactSecrets(text, [])).toContain('[REDACTED]');
    expect(redactSecrets(text, [])).not.toContain('sk-abc');
  });

  it('should redact Slack bot tokens', () => {
    const text = 'token xoxb-1234567890-abcdef';
    expect(redactSecrets(text, [])).toContain('[REDACTED]');
  });

  it('should redact Authorization Bearer headers', () => {
    const text = 'Authorization: Bearer my-secret-token-value';
    expect(redactSecrets(text, [])).toContain('[REDACTED]');
  });

  it('should redact token= assignments', () => {
    const text = 'token=supersecret123';
    expect(redactSecrets(text, [])).toContain('[REDACTED]');
  });

  it('should apply custom redaction patterns', () => {
    const text = 'MY_CUSTOM_SECRET=abc123';
    expect(redactSecrets(text, [/MY_CUSTOM_SECRET=\S+/])).toContain('[REDACTED]');
  });

  it('should not modify safe text', () => {
    const text = 'Task 3 completed successfully.';
    expect(redactSecrets(text, [])).toBe(text);
  });

  it('should handle empty string', () => {
    expect(redactSecrets('', [])).toBe('');
  });
});

describe('isAllowedUser', () => {
  it('should allow users in the allowed list', () => {
    expect(isAllowedUser('U123', ['U123', 'U456'])).toBe(true);
  });

  it('should reject users not in the allowed list', () => {
    expect(isAllowedUser('U999', ['U123', 'U456'])).toBe(false);
  });

  it('should reject when allowed list is empty', () => {
    expect(isAllowedUser('U123', [])).toBe(false);
  });

  it('should be case-sensitive', () => {
    expect(isAllowedUser('u123', ['U123'])).toBe(false);
  });
});
