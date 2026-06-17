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

  it('applies defaults for recovery, permissions, gates, and session.tmux_socket', async () => {
    const configDir = join(tmpDir, '.aisup');
    mkdirSync(configDir, { mode: 0o700 });
    const accountDir = join(tmpDir, '.claude');
    mkdirSync(accountDir);
    writeFileSync(join(configDir, 'config.yaml'), `
accounts:
  - name: primary
    config_dir: ${accountDir}
`);

    const config = await loadConfig(join(configDir, 'config.yaml'));

    expect(config.session.tmux_socket).toBe('aisup');
    expect(config.recovery.auto_resume_exhausted).toBe(true);
    expect(config.recovery.exhausted_poll_interval_s).toBe(60);
    expect(config.recovery.network_error_threshold).toBe(3);
    expect(config.recovery.max_exhausted_retries).toBe(5);
    expect(config.permissions.enabled).toBe(false);
    expect(config.permissions.detection_patterns).toEqual([]);
    expect(config.permissions.approval_key).toBe('y');
    expect(config.permissions.denial_key).toBe('n');
    expect(config.permissions.policy.default_action).toBe('deny');
    expect(config.permissions.slack_routing).toBe(false);
    expect(config.permissions.grant_ttl_seconds).toBe(300);
    expect(config.gates.enabled).toBe(false);
    expect(config.gates.gates).toEqual([]);
    expect(config.gates.trigger).toBe('idle_and_skill');
    expect(config.gates.idle_delay_seconds).toBe(30);
  });

  it('accepts custom recovery/permissions/gates values and detection-pattern overrides', async () => {
    const configDir = join(tmpDir, '.aisup');
    mkdirSync(configDir, { mode: 0o700 });
    const accountDir = join(tmpDir, '.claude');
    mkdirSync(accountDir);
    writeFileSync(join(configDir, 'config.yaml'), `
accounts:
  - name: primary
    config_dir: ${accountDir}
session:
  tmux_socket: aisup-test-123
recovery:
  auto_resume_exhausted: false
  max_exhausted_retries: 9
permissions:
  enabled: true
  detection_patterns:
    - "Do you want to proceed"
  approval_key: "1"
  denial_key: "2"
  policy:
    default_action: allow
gates:
  enabled: true
  trigger: manual
  gates:
    - name: typecheck
      command: npx
      args: ["tsc", "--noEmit"]
      timeout_seconds: 60
      required: true
      cwd: null
`);

    const config = await loadConfig(join(configDir, 'config.yaml'));

    expect(config.session.tmux_socket).toBe('aisup-test-123');
    expect(config.recovery.auto_resume_exhausted).toBe(false);
    expect(config.recovery.max_exhausted_retries).toBe(9);
    expect(config.permissions.enabled).toBe(true);
    expect(config.permissions.detection_patterns).toContain('Do you want to proceed');
    expect(config.permissions.policy.default_action).toBe('allow');
    expect(config.gates.enabled).toBe(true);
    expect(config.gates.trigger).toBe('manual');
    expect(config.gates.gates[0].command).toBe('npx');
    expect(config.gates.gates[0].args).toEqual(['tsc', '--noEmit']);
  });

  it('rejects a gate command that embeds arguments', async () => {
    const configDir = join(tmpDir, '.aisup');
    mkdirSync(configDir, { mode: 0o700 });
    const accountDir = join(tmpDir, '.claude');
    mkdirSync(accountDir);
    writeFileSync(join(configDir, 'config.yaml'), `
accounts:
  - name: primary
    config_dir: ${accountDir}
gates:
  gates:
    - name: typecheck
      command: "npx tsc --noEmit"
      args: []
      timeout_seconds: 60
      required: true
      cwd: null
`);

    await expect(loadConfig(join(configDir, 'config.yaml'))).rejects.toThrow(/command|argument/i);
  });

  it('rejects an invalid tmux socket name', async () => {
    const configDir = join(tmpDir, '.aisup');
    mkdirSync(configDir, { mode: 0o700 });
    const accountDir = join(tmpDir, '.claude');
    mkdirSync(accountDir);
    writeFileSync(join(configDir, 'config.yaml'), `
accounts:
  - name: primary
    config_dir: ${accountDir}
session:
  tmux_socket: "bad/socket name"
`);

    await expect(loadConfig(join(configDir, 'config.yaml'))).rejects.toThrow(/tmux_socket/i);
  });

  it('rejects approval/denial keys that contain control characters', async () => {
    const configDir = join(tmpDir, '.aisup');
    mkdirSync(configDir, { mode: 0o700 });
    const accountDir = join(tmpDir, '.claude');
    mkdirSync(accountDir);
    writeFileSync(join(configDir, 'config.yaml'), `
accounts:
  - name: primary
    config_dir: ${accountDir}
permissions:
  approval_key: "\\n"
`);

    await expect(loadConfig(join(configDir, 'config.yaml'))).rejects.toThrow(/approval_key/i);
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

describe('loadConfig — workers section', () => {
  let tmpDir: string;
  let origHome: string | undefined;
  let accountDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'aisup-workers-'));
    origHome = process.env.HOME;
    process.env.HOME = tmpDir;
    accountDir = join(tmpDir, '.claude');
    mkdirSync(accountDir, { recursive: true });
    resetConfigCache();
  });

  afterEach(() => {
    process.env.HOME = origHome;
    rmSync(tmpDir, { recursive: true, force: true });
    resetConfigCache();
  });

  function writeConfig(workersYaml: string): string {
    const configDir = join(tmpDir, '.aisup');
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
    const path = join(configDir, 'config.yaml');
    writeFileSync(
      path,
      `accounts:\n  - name: primary\n    config_dir: ${accountDir}\n${workersYaml}`
    );
    return path;
  }

  // A fully-valid enabled workers config; flip one field per invalid-case test.
  const enabledBase = `workers:
  enabled: true
  adapters:
    codex:
      enabled: true
    gemini:
      enabled: true
  routing:
    default_implementer: codex
    default_reviewer: gemini
  validation_gates:
    - name: test
      command: "true"
      args: []
      timeout_seconds: 60
      required: true
      cwd: null
`;

  it('returns a fully-populated workers section for an empty config (defaults)', async () => {
    const config = await loadConfig(writeConfig(''));
    expect(config.workers.enabled).toBe(false);
    expect(config.workers.workspace_root).toBeNull();
    expect(config.workers.worktree_dir).toBe('.aisup-workers');
    expect(config.workers.base_ref).toBe('HEAD');
    expect(config.workers.max_concurrent).toBe(2);
    expect(config.workers.retention.max_age_hours).toBe(168);
    expect(config.workers.security.boundary_audit).toBe(true);
    expect(config.workers.security.forbidden_path_globs).toContain('**/.env');
    expect(config.workers.adapters.codex.command).toBe('codex');
    expect(config.workers.adapters.codex.name).toBe('codex');
    expect(config.workers.adapters.codex.enabled).toBe(false);
    expect(config.workers.routing.default_implementer).toBe('codex');
    expect(config.workers.review.allow_same_model_review).toBe(false);
    expect(config.workers.merge.require_approval).toBe(true);
    expect(config.workers.validation.allow_no_validation).toBe(false);
  });

  it('returns a custom enabled workers section and injects adapter names from keys', async () => {
    const config = await loadConfig(writeConfig(enabledBase));
    expect(config.workers.enabled).toBe(true);
    expect(config.workers.adapters.codex.enabled).toBe(true);
    expect(config.workers.adapters.gemini.enabled).toBe(true);
    expect(config.workers.adapters.gemini.name).toBe('gemini');
    expect(config.workers.validation_gates).toHaveLength(1);
    expect(config.workers.validation_gates[0].required).toBe(true);
  });

  it('rejects merge.require_approval: false', async () => {
    await expect(
      loadConfig(writeConfig('workers:\n  merge:\n    require_approval: false\n'))
    ).rejects.toThrow(/require_approval/i);
  });

  it('rejects security.boundary_audit: false', async () => {
    await expect(
      loadConfig(writeConfig('workers:\n  security:\n    boundary_audit: false\n'))
    ).rejects.toThrow(/boundary_audit/i);
  });

  it('rejects an adapter command that embeds arguments (whitespace)', async () => {
    await expect(
      loadConfig(writeConfig('workers:\n  adapters:\n    codex:\n      command: "codex --run"\n'))
    ).rejects.toThrow(/command|argument/i);
  });

  it('rejects routing referencing an undefined adapter', async () => {
    await expect(
      loadConfig(
        writeConfig('workers:\n  routing:\n    default_reviewer: nonesuch\n')
      )
    ).rejects.toThrow(/nonesuch|adapter/i);
  });

  it('rejects worktree_dir containing ..', async () => {
    await expect(
      loadConfig(writeConfig('workers:\n  worktree_dir: "../escape"\n'))
    ).rejects.toThrow(/worktree_dir/i);
  });

  it('rejects worktree_dir of "."', async () => {
    await expect(
      loadConfig(writeConfig('workers:\n  worktree_dir: "."\n'))
    ).rejects.toThrow(/worktree_dir/i);
  });

  it('rejects worktree_dir of ".git"', async () => {
    await expect(
      loadConfig(writeConfig('workers:\n  worktree_dir: ".git"\n'))
    ).rejects.toThrow(/worktree_dir/i);
  });

  it('rejects a validation_gates entry carrying a non-null cwd', async () => {
    const badGate = enabledBase.replace('      cwd: null\n', '      cwd: /some/path\n');
    await expect(loadConfig(writeConfig(badGate))).rejects.toThrow(/cwd/i);
  });

  it('rejects default_implementer naming a disabled adapter when enabled', async () => {
    const yaml = `workers:
  enabled: true
  adapters:
    gemini:
      enabled: true
  routing:
    default_implementer: codex
    default_reviewer: gemini
  validation_gates:
    - name: test
      command: "true"
      args: []
      timeout_seconds: 60
      required: true
      cwd: null
`;
    await expect(loadConfig(writeConfig(yaml))).rejects.toThrow(/codex|enabled|implementer/i);
  });

  it('rejects a by_task_type reviewer naming a disabled adapter', async () => {
    // append a by_task_type referencing disabled "local"
    const withRoute = enabledBase.replace(
      '    default_reviewer: gemini\n',
      '    default_reviewer: gemini\n    by_task_type:\n      bugfix:\n        implementer: codex\n        reviewer: local\n'
    );
    await expect(loadConfig(writeConfig(withRoute))).rejects.toThrow(/local|disabled|reviewer/i);
  });

  it('rejects base_ref beginning with -', async () => {
    await expect(
      loadConfig(writeConfig('workers:\n  base_ref: "--help"\n'))
    ).rejects.toThrow(/base_ref/i);
  });

  it('rejects the removed review.parse_failure_verdict field', async () => {
    await expect(
      loadConfig(writeConfig('workers:\n  review:\n    parse_failure_verdict: approve\n'))
    ).rejects.toThrow(/parse_failure_verdict/i);
  });

  it('rejects the removed review.require_cross_model field', async () => {
    await expect(
      loadConfig(writeConfig('workers:\n  review:\n    require_cross_model: true\n'))
    ).rejects.toThrow(/require_cross_model/i);
  });

  it('rejects enabled workers with no required validation gate and allow_no_validation: false', async () => {
    const yaml = `workers:
  enabled: true
  adapters:
    codex:
      enabled: true
    gemini:
      enabled: true
  routing:
    default_implementer: codex
    default_reviewer: gemini
  validation_gates: []
`;
    await expect(loadConfig(writeConfig(yaml))).rejects.toThrow(/validation|required|gate/i);
  });
});
