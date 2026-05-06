import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateInitConfig } from '../../src/cli/commands/init.js';

describe('generateInitConfig', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'aisup-init-'));
    process.env.HOME = tmpDir;
    mkdirSync(join(tmpDir, '.claude'), { recursive: true });
    mkdirSync(join(tmpDir, '.claude-account2'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should return default config YAML string', () => {
    const { yaml } = generateInitConfig();
    expect(yaml).toContain('accounts:');
    expect(yaml).toContain('runner:');
    expect(yaml).toContain('thresholds:');
    expect(yaml).toContain('daemon:');
  });

  it('should not contain token-like strings (32+ char alphanumeric)', () => {
    const { yaml, tokenNote } = generateInitConfig();
    // Neither the YAML nor the token note should contain an actual token value
    const combined = yaml + tokenNote;
    const tokenPattern = /[a-zA-Z0-9_-]{32,}/g;
    const matches = combined.match(tokenPattern) ?? [];
    // Filter out things that are legitimately long (like config paths, regex patterns)
    const suspiciousTokens = matches.filter(
      (m) => !m.includes('/') && !m.includes('.') && !/^[-a-z_]+$/.test(m)
    );
    expect(suspiciousTokens).toHaveLength(0);
  });

  it('should include token note saying where token would be generated', () => {
    const { tokenNote } = generateInitConfig();
    expect(tokenNote).toMatch(/api-token/i);
    expect(tokenNote).toMatch(/would generate|will be created/i);
  });

  it('should include placeholder account entries', () => {
    const { yaml } = generateInitConfig();
    expect(yaml).toContain('primary');
    expect(yaml).toContain('~/.claude');
  });
});
