import { describe, it, expect, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildClaudeWorkerCommand, parseClaudeResult } from '../../src/workers/claude-adapter.js';
import { loadConfig } from '../../src/config/loader.js';

/**
 * Host-gated: a REAL `claude -p` worker edits a file in a scratch worktree under real account auth.
 * Skipped unless AISUP_TEST_CLAUDE_WORKER=1. Account auth dir comes from AISUP_TEST_CLAUDE_CONFIG_DIR
 * or the first enabled account in the live ~/.aisup/config.yaml. Yields PASS or SKIP, never a harness ERROR.
 */

const execFileAsync = promisify(execFile);
const enabled = process.env.AISUP_TEST_CLAUDE_WORKER === '1';

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd });
}

async function resolveConfigDir(): Promise<string> {
  const override = process.env.AISUP_TEST_CLAUDE_CONFIG_DIR;
  if (override) return override;
  const cfg = await loadConfig();
  const account = cfg.accounts.find((a) => a.enabled);
  if (!account) throw new Error('no enabled account in ~/.aisup/config.yaml and AISUP_TEST_CLAUDE_CONFIG_DIR unset');
  return account.config_dir;
}

describe.skipIf(!enabled)('claude -p host-gated worker run (set AISUP_TEST_CLAUDE_WORKER=1 to enable)', () => {
  let scratch: string;

  afterEach(() => {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  });

  it('edits a file in a scratch worktree (non-empty diff) and parses a usage object', async () => {
    // Canonical /private/tmp so HOME-resolution and git agree on the path.
    scratch = join('/private/tmp', `aisup-claude-test-${randomUUID()}`);
    mkdirSync(join(scratch, '.home'), { recursive: true });
    writeFileSync(join(scratch, 'README.md'), '# scratch\n');
    await git(scratch, ['init', '-q']);
    await git(scratch, ['config', 'user.email', 'test@example.com']);
    await git(scratch, ['config', 'user.name', 'aisup test']);
    await git(scratch, ['add', '.']);
    await git(scratch, ['commit', '-q', '-m', 'init']);

    const config_dir = await resolveConfigDir();
    const plan = buildClaudeWorkerCommand({
      account: { name: 'host-gated', config_dir },
      prompt: 'Append a new line that says "hello from worker" to README.md. Make only that edit.',
      worktreePath: scratch,
      envAllowlist: ['PATH'],
    });

    const { stdout } = await execFileAsync(plan.command, plan.args, {
      cwd: scratch,
      env: plan.env,
      timeout: 180_000,
      maxBuffer: 10 * 1024 * 1024,
    });

    const diff = await execFileAsync('git', ['diff'], { cwd: scratch });
    expect(diff.stdout.trim().length).toBeGreaterThan(0);

    const parsed = parseClaudeResult(stdout);
    expect(parsed.usage).not.toBeNull();
    expect(parsed.usage!.input_tokens).toBeGreaterThan(0);
  }, 200_000);
});
