import { join } from 'node:path';
import { aisupHome } from '../../config/paths.js';
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';

const DEFAULT_CONFIG_YAML = `accounts:
  - name: primary
    config_dir: ~/.claude
    priority: 1
    enabled: true
  - name: account2
    config_dir: ~/.claude-account2
    priority: 2
    enabled: true
runner:
  command: pilot
  args: []
  resume_flag: --resume
  config_dir_env: CLAUDE_CONFIG_DIR
  remote_control_prefix: null
thresholds:
  soft_pct: 85
  hard_pct: 95
  idle_boundary_seconds: 30
failover:
  circuit_breaker_max_failures: 3
  circuit_breaker_cooldown_seconds: 300
skills:
  tracked: ["/prd", "/spec", "/fix", "/review", "/security-review"]
monitoring:
  rate_limit_interval_s: 30
  health_interval_s: 60
  recovery_interval_s: 5
  idle_interval_s: 120
session:
  output_log_max_size_mb: 50
  output_log_retention_days: 7
  resume_prompt_mode: never
slack:
  enabled: false
  bot_token_env: AISUP_SLACK_BOT_TOKEN
  app_token_env: AISUP_SLACK_APP_TOKEN
  allowed_user_ids: []
  relay_output_enabled: false
  cmd_require_confirmation: true
daemon:
  port: 7394
  log_max_size_mb: 10
statusline:
  directory: /tmp/pilot-failover
  freshness_window_s: 300
journal:
  path: ~/.aisup/journal.jsonl
`;

export interface InitConfigResult {
  yaml: string;
  tokenNote: string;
}

export function generateInitConfig(): InitConfigResult {
  return {
    yaml: DEFAULT_CONFIG_YAML,
    tokenNote: 'Would generate API token at ~/.aisup/api-token (random bearer token, mode 0600)',
  };
}

export async function runInit(opts: { dryRun?: boolean; force?: boolean }): Promise<void> {
  const aisupDir = aisupHome();
  const configPath = join(aisupDir, 'config.yaml');
  const tokenPath = join(aisupDir, 'api-token');

  const { yaml, tokenNote } = generateInitConfig();

  if (opts.dryRun) {
    console.log('--- Would write to:', configPath, '---');
    console.log(yaml);
    console.log(tokenNote);
    return;
  }

  if (existsSync(configPath) && !opts.force) {
    console.error(`Config already exists at ${configPath}. Use --force to overwrite.`);
    process.exit(1);
  }

  mkdirSync(aisupDir, { recursive: true, mode: 0o700 });
  writeFileSync(configPath, yaml, { mode: 0o600 });

  // Generate random bearer token
  const { randomBytes } = await import('node:crypto');
  const token = randomBytes(32).toString('hex');
  writeFileSync(tokenPath, token, { mode: 0o600 });

  console.log(`Config written to ${configPath}`);
  console.log(`API token written to ${tokenPath}`);
}
