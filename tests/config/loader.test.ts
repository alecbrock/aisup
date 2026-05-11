import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Import after creating test fixtures so the module resolves
import { loadConfig, resetConfigCache } from '../../src/config/loader.js';

describe('loadConfig', () => {
  let tmpDir: string;
  let origHome: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'aisup-test-'));
    origHome = process.env.HOME;
    process.env.HOME = tmpDir;
    resetConfigCache();
  });

  afterEach(() => {
    process.env.HOME = origHome;
    rmSync(tmpDir, { recursive: true, force: true });
    resetConfigCache();
  });

  it('should parse a valid YAML config and return typed config object', async () => {
    const configDir = join(tmpDir, '.aisup');
    mkdirSync(configDir, { mode: 0o700 });
    const accountDir = join(tmpDir, '.claude');
    mkdirSync(accountDir);

    const yaml = `
accounts:
  - name: primary
    config_dir: ${accountDir}
    priority: 1
runner:
  command: pilot
thresholds:
  soft_pct: 85
  hard_pct: 95
`;
    writeFileSync(join(configDir, 'config.yaml'), yaml);

    const config = await loadConfig(join(configDir, 'config.yaml'));

    expect(config.accounts).toHaveLength(1);
    expect(config.accounts[0].name).toBe('primary');
    expect(config.accounts[0].config_dir).toBe(accountDir);
    expect(config.accounts[0].priority).toBe(1);
    expect(config.accounts[0].enabled).toBe(true);
    expect(config.runner.command).toBe('pilot');
    expect(config.thresholds.soft_pct).toBe(85);
    expect(config.thresholds.hard_pct).toBe(95);
  });

  it('should apply defaults for omitted fields', async () => {
    const configDir = join(tmpDir, '.aisup');
    mkdirSync(configDir, { mode: 0o700 });
    const accountDir = join(tmpDir, '.claude');
    mkdirSync(accountDir);

    const yaml = `
accounts:
  - name: primary
    config_dir: ${accountDir}
`;
    writeFileSync(join(configDir, 'config.yaml'), yaml);

    const config = await loadConfig(join(configDir, 'config.yaml'));

    expect(config.runner.command).toBe('pilot');
    expect(config.runner.resume_flag).toBe('--resume');
    expect(config.runner.config_dir_env).toBe('CLAUDE_CONFIG_DIR');
    expect(config.thresholds.soft_pct).toBe(85);
    expect(config.thresholds.hard_pct).toBe(95);
    expect(config.thresholds.idle_boundary_seconds).toBe(30);
    expect(config.failover.circuit_breaker_max_failures).toBe(3);
    expect(config.failover.circuit_breaker_cooldown_seconds).toBe(300);
    expect(config.monitoring.rate_limit_interval_s).toBe(30);
    expect(config.monitoring.health_interval_s).toBe(60);
    expect(config.monitoring.recovery_interval_s).toBe(5);
    expect(config.monitoring.idle_interval_s).toBe(120);
    expect(config.session.output_log_max_size_mb).toBe(50);
    expect(config.session.output_log_retention_days).toBe(7);
    expect(config.slack.enabled).toBe(false);
    expect(config.daemon.port).toBe(7394);
    expect(config.statusline.directory).toBe('/tmp/pilot-failover');
    expect(config.statusline.freshness_window_s).toBe(300);
  });

  it('should expand ~ in path fields', async () => {
    const configDir = join(tmpDir, '.aisup');
    mkdirSync(configDir, { mode: 0o700 });
    const accountDir = join(tmpDir, '.claude');
    mkdirSync(accountDir);

    const yaml = `
accounts:
  - name: primary
    config_dir: ~/.claude
journal:
  path: ~/.aisup/journal.jsonl
`;
    writeFileSync(join(configDir, 'config.yaml'), yaml);

    const config = await loadConfig(join(configDir, 'config.yaml'));

    expect(config.accounts[0].config_dir).toBe(join(tmpDir, '.claude'));
    expect(config.journal.path).toBe(join(tmpDir, '.aisup', 'journal.jsonl'));
  });

  it('should throw on empty accounts array', async () => {
    const configDir = join(tmpDir, '.aisup');
    mkdirSync(configDir, { mode: 0o700 });
    writeFileSync(join(configDir, 'config.yaml'), 'accounts: []\n');

    await expect(loadConfig(join(configDir, 'config.yaml'))).rejects.toThrow(/accounts/i);
  });

  it('should throw on invalid account name characters', async () => {
    const configDir = join(tmpDir, '.aisup');
    mkdirSync(configDir, { mode: 0o700 });
    const accountDir = join(tmpDir, '.claude');
    mkdirSync(accountDir);

    const yaml = `
accounts:
  - name: "my account!"
    config_dir: ${accountDir}
`;
    writeFileSync(join(configDir, 'config.yaml'), yaml);

    await expect(loadConfig(join(configDir, 'config.yaml'))).rejects.toThrow(/account name/i);
  });

  it('should throw on threshold out of range', async () => {
    const configDir = join(tmpDir, '.aisup');
    mkdirSync(configDir, { mode: 0o700 });
    const accountDir = join(tmpDir, '.claude');
    mkdirSync(accountDir);

    const yaml = `
accounts:
  - name: primary
    config_dir: ${accountDir}
thresholds:
  soft_pct: 150
`;
    writeFileSync(join(configDir, 'config.yaml'), yaml);

    await expect(loadConfig(join(configDir, 'config.yaml'))).rejects.toThrow(/threshold|soft_pct/i);
  });

  it('should throw on invalid port', async () => {
    const configDir = join(tmpDir, '.aisup');
    mkdirSync(configDir, { mode: 0o700 });
    const accountDir = join(tmpDir, '.claude');
    mkdirSync(accountDir);

    const yaml = `
accounts:
  - name: primary
    config_dir: ${accountDir}
daemon:
  port: 99999
`;
    writeFileSync(join(configDir, 'config.yaml'), yaml);

    await expect(loadConfig(join(configDir, 'config.yaml'))).rejects.toThrow(/port/i);
  });

  it('should throw on path with NUL byte', async () => {
    const configDir = join(tmpDir, '.aisup');
    mkdirSync(configDir, { mode: 0o700 });

    const yaml = `
accounts:
  - name: primary
    config_dir: /some/path\x00evil
`;
    writeFileSync(join(configDir, 'config.yaml'), yaml);

    await expect(loadConfig(join(configDir, 'config.yaml'))).rejects.toThrow(/NUL|invalid.*path|path.*invalid/i);
  });

  it('should create ~/.aisup directory with mode 0700 when missing', async () => {
    const configDir = join(tmpDir, '.aisup');
    const accountDir = join(tmpDir, '.claude');
    mkdirSync(accountDir);

    const yaml = `
accounts:
  - name: primary
    config_dir: ${accountDir}
`;
    // Write config to a temp path outside ~/.aisup to trigger dir creation
    const configPath = join(tmpDir, 'config.yaml');
    writeFileSync(configPath, yaml);

    // loadConfig with explicit path should still ensure ~/.aisup exists
    await loadConfig(configPath);

    const stat = statSync(configDir);
    expect(stat.isDirectory()).toBe(true);
    // mode 0700 = owner rwx only
    expect(stat.mode & 0o777).toBe(0o700);
  });

  it('should create default config with placeholder values when file is missing', async () => {
    const configPath = join(tmpDir, '.aisup', 'config.yaml');
    // file does NOT exist

    const config = await loadConfig(configPath);

    // Returns a valid config object with placeholder accounts
    expect(config.accounts.length).toBeGreaterThan(0);
    expect(config.accounts[0].name).toBe('primary');
    // Default runner/threshold values applied
    expect(config.runner.command).toBe('pilot');
    expect(config.thresholds.soft_pct).toBe(85);
    // File is written to disk
    const { existsSync } = await import('node:fs');
    expect(existsSync(configPath)).toBe(true);
  });

  it('should cache config on second call', async () => {
    const configDir = join(tmpDir, '.aisup');
    mkdirSync(configDir, { mode: 0o700 });
    const accountDir = join(tmpDir, '.claude');
    mkdirSync(accountDir);

    const yaml = `
accounts:
  - name: primary
    config_dir: ${accountDir}
`;
    const configPath = join(configDir, 'config.yaml');
    writeFileSync(configPath, yaml);

    const config1 = await loadConfig(configPath);
    const config2 = await loadConfig(configPath);
    expect(config1).toBe(config2); // same reference
  });

  it('should accept paths with shell metacharacters', async () => {
    const configDir = join(tmpDir, '.aisup');
    mkdirSync(configDir, { mode: 0o700 });
    // Create a path with spaces (valid filesystem path)
    const accountDir = join(tmpDir, 'my claude dir');
    mkdirSync(accountDir);

    const yaml = `
accounts:
  - name: primary
    config_dir: "${accountDir}"
`;
    writeFileSync(join(configDir, 'config.yaml'), yaml);

    const config = await loadConfig(join(configDir, 'config.yaml'));
    expect(config.accounts[0].config_dir).toBe(accountDir);
  });

  it('should require configured account dirs to exist', async () => {
    const configDir = join(tmpDir, '.aisup');
    mkdirSync(configDir, { mode: 0o700 });

    const yaml = `
accounts:
  - name: primary
    config_dir: ${join(tmpDir, 'missing account dir')}
`;
    writeFileSync(join(configDir, 'config.yaml'), yaml);

    await expect(loadConfig(join(configDir, 'config.yaml'))).rejects.toThrow(/config_dir.*not found|account.*not found/i);
  });

  it('should expand statusline.directory and validate Slack enabled prerequisites', async () => {
    const configDir = join(tmpDir, '.aisup');
    mkdirSync(configDir, { mode: 0o700 });
    const accountDir = join(tmpDir, '.claude');
    mkdirSync(accountDir);
    mkdirSync(join(tmpDir, 'statusline'));

    const yaml = `
accounts:
  - name: primary
    config_dir: ${accountDir}
statusline:
  directory: ~/statusline
slack:
  enabled: true
  allowed_user_ids: []
`;
    writeFileSync(join(configDir, 'config.yaml'), yaml);

    await expect(loadConfig(join(configDir, 'config.yaml'))).rejects.toThrow(/allowed_user_ids/i);
  });
});
