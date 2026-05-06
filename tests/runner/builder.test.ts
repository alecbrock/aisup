import { describe, it, expect } from 'vitest';
import { buildLaunchCommand, buildResumeCommand, validateRunner } from '../../src/runner/builder.js';
import { singleQuote } from '../../src/util/shell.js';
import type { RunnerConfig } from '../../src/runner/types.js';

const BASE_CONFIG: RunnerConfig = {
  command: '/usr/local/bin/pilot',
  args: [],
  resume_flag: '--resume',
  config_dir_env: 'CLAUDE_CONFIG_DIR',
  remote_control_prefix: null,
};

describe('singleQuote', () => {
  it('should wrap a simple string in single quotes', () => {
    expect(singleQuote('hello')).toBe("'hello'");
  });

  it('should escape internal single quotes', () => {
    expect(singleQuote("hello 'world'")).toBe("'hello '\\''world'\\'''");
  });

  it('should handle paths with spaces', () => {
    const p = '/my path/to file';
    expect(singleQuote(p)).toBe("'/my path/to file'");
  });

  it('should handle $ metacharacter', () => {
    const p = '/path/$HOME/file';
    expect(singleQuote(p)).toBe("'/path/$HOME/file'");
  });

  it('should handle backticks', () => {
    const p = '/path/`cmd`/file';
    expect(singleQuote(p)).toBe("'/path/`cmd`/file'");
  });

  it('should handle semicolons', () => {
    const p = '/path;rm -rf /';
    expect(singleQuote(p)).toBe("'/path;rm -rf /'");
  });

  it('should handle empty string', () => {
    expect(singleQuote('')).toBe("''");
  });

  it('should handle only a single quote', () => {
    expect(singleQuote("'")).toBe("''\\'''");
  });
});

describe('buildLaunchCommand', () => {
  it('should return structured command/args/env', () => {
    const result = buildLaunchCommand(BASE_CONFIG, '/home/user/.claude');
    expect(result.command).toBe('/usr/local/bin/pilot');
    expect(Array.isArray(result.args)).toBe(true);
    expect(typeof result.env).toBe('object');
  });

  it('should use config_dir_env key for env var name', () => {
    const result = buildLaunchCommand(BASE_CONFIG, '/home/user/.claude');
    expect(result.env['CLAUDE_CONFIG_DIR']).toBe('/home/user/.claude');
  });

  it('should use custom config_dir_env name from config', () => {
    const config: RunnerConfig = { ...BASE_CONFIG, config_dir_env: 'MY_CONFIG_DIR' };
    const result = buildLaunchCommand(config, '/some/dir');
    expect(result.env['MY_CONFIG_DIR']).toBe('/some/dir');
    expect(result.env['CLAUDE_CONFIG_DIR']).toBeUndefined();
  });

  it('should include extra args from config.args', () => {
    const config: RunnerConfig = { ...BASE_CONFIG, args: ['--model', 'opus'] };
    const result = buildLaunchCommand(config, '/home/user/.claude');
    expect(result.args).toContain('--model');
    expect(result.args).toContain('opus');
  });

  it('should add remote_control_prefix flag when set', () => {
    const config: RunnerConfig = { ...BASE_CONFIG, remote_control_prefix: 'aisup' };
    const result = buildLaunchCommand(config, '/home/user/.claude');
    expect(result.args).toContain('--remote-control-session-name-prefix');
    expect(result.args).toContain('aisup');
  });

  it('should NOT add remote_control_prefix flag when null', () => {
    const result = buildLaunchCommand(BASE_CONFIG, '/home/user/.claude');
    expect(result.args).not.toContain('--remote-control-session-name-prefix');
  });

  it('should produce exec string with properly escaped tokens', () => {
    const config: RunnerConfig = {
      ...BASE_CONFIG,
      command: '/path with spaces/pilot',
    };
    const result = buildLaunchCommand(config, '/claude dir/$HOME');
    const execStr = result.execString;
    // exec string should single-quote all tokens
    expect(execStr).toMatch(/^exec /);
    expect(execStr).toContain("'/path with spaces/pilot'");
  });
});

describe('buildResumeCommand', () => {
  it('should append resume flag and session ID', () => {
    const result = buildResumeCommand(BASE_CONFIG, '/home/user/.claude', 'sess-abc123');
    expect(result.args).toContain('--resume');
    expect(result.args).toContain('sess-abc123');
  });

  it('should throw if claudeSessionId is null', () => {
    expect(() => buildResumeCommand(BASE_CONFIG, '/home/user/.claude', null)).toThrow(
      /claudeSessionId.*null|null.*claudeSessionId/i
    );
  });

  it('should include config_dir_env in env', () => {
    const result = buildResumeCommand(BASE_CONFIG, '/home/user/.claude', 'sess-abc123');
    expect(result.env['CLAUDE_CONFIG_DIR']).toBe('/home/user/.claude');
  });
});

describe('validateRunner', () => {
  it('should resolve /bin/sh to an absolute path', () => {
    const resolved = validateRunner({ ...BASE_CONFIG, command: '/bin/sh' });
    expect(resolved.startsWith('/')).toBe(true);
    expect(resolved).toBe('/bin/sh');
  });

  it('should throw for a non-existent command', () => {
    expect(() => validateRunner({ ...BASE_CONFIG, command: '/nonexistent/runner' })).toThrow(
      /not found|not executable|ENOENT/i
    );
  });

  it('should resolve a command on PATH to absolute path', () => {
    // /bin/sh is always on PATH
    const resolved = validateRunner({ ...BASE_CONFIG, command: 'sh' });
    expect(resolved.startsWith('/')).toBe(true);
  });
});
