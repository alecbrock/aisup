import { describe, it, expect } from 'vitest';
import { detectAuthFailure, detectNetworkError } from '../../src/recovery/patterns.js';

describe('recovery output failure patterns', () => {
  describe('detectAuthFailure', () => {
    it.each([
      'API Error: Authentication failed',
      'Invalid API key · Please run /login',
      'HTTP 401 Unauthorized',
      'OAuth token has expired',
      'Error: invalid bearer token',
      'Your session ended. Please run /login to continue.',
    ])('matches auth failure output: %s', (line) => {
      expect(detectAuthFailure(line)).toBe(true);
    });

    it.each([
      'I will authenticate your request now',
      '401 tests passed',
      'This action is allowed for authorized users',
      'the API key is valid and configured',
      'configuring oauth for the new provider',
      'normal claude output continues here',
    ])('does not match ordinary prose: %s', (line) => {
      expect(detectAuthFailure(line)).toBe(false);
    });

    it('matches even when wrapped in ANSI color codes', () => {
      expect(detectAuthFailure('\x1b[31m401 Unauthorized\x1b[0m')).toBe(true);
    });
  });

  describe('detectNetworkError', () => {
    it.each([
      'Error: connect ECONNREFUSED 127.0.0.1:443',
      'getaddrinfo ENOTFOUND api.anthropic.com',
      'request to https://api failed, reason: ETIMEDOUT',
      'network error while contacting the API',
      'connection reset by peer',
      'fetch failed',
      'socket hang up',
      'read ECONNRESET',
    ])('matches network error output: %s', (line) => {
      expect(detectNetworkError(line)).toBe(true);
    });

    it.each([
      'the network is stable and healthy',
      'connection established successfully',
      'reconnected to the server',
      'normal claude output continues here',
    ])('does not match ordinary prose: %s', (line) => {
      expect(detectNetworkError(line)).toBe(false);
    });

    it('matches even when wrapped in ANSI color codes', () => {
      expect(detectNetworkError('\x1b[33mECONNREFUSED\x1b[0m')).toBe(true);
    });
  });
});
