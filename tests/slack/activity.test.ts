import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  isMeaningful,
  renderActivityRow,
  renderActivityDetail,
  type ActivityInput,
} from '../../src/slack/activity.js';

vi.mock('../../src/session/tmux.js', () => ({
  sendInterrupt: vi.fn(), sendEnter: vi.fn(), sendText: vi.fn(),
  captureOutput: vi.fn().mockReturnValue(''), isProcessDead: vi.fn().mockReturnValue(false),
  createTmuxSession: vi.fn(), destroyTmuxSession: vi.fn(), stopPipePane: vi.fn(),
  startOutputLog: vi.fn(), listSessions: vi.fn().mockReturnValue([]),
}));
const posted: Array<Record<string, unknown>> = [];
const opened: Array<Record<string, unknown>> = [];
let tsCounter = 0;
vi.mock('@slack/bolt', () => {
  const FakeApp = vi.fn().mockImplementation(() => ({
    message: vi.fn(), action: vi.fn(), view: vi.fn(),
    start: vi.fn().mockResolvedValue(undefined), stop: vi.fn().mockResolvedValue(undefined),
    client: {
      auth: { test: vi.fn().mockResolvedValue({ ok: true }) },
      chat: { postMessage: vi.fn().mockImplementation((a) => { posted.push(a); return Promise.resolve({ ts: `ts-${++tsCounter}` }); }) },
      views: { open: vi.fn().mockImplementation((a) => { opened.push(a); return Promise.resolve({}); }) },
    },
  }));
  return { App: FakeApp };
});

import { SlackService } from '../../src/slack/service.js';
import { ACTIVITY_EXPAND_ACTION } from '../../src/slack/blocks.js';
import type { SlackConfig } from '../../src/config/schema.js';

const ident = (s: string): string => s;
const mask = (s: string): string => s.replace(/topsecret\w*/g, '***');

describe('activity classification', () => {
  it('treats Edit/Write/Bash/Task as meaningful at normal; Read/Grep are not', () => {
    for (const t of ['Edit', 'Write', 'MultiEdit', 'Bash', 'Task']) {
      expect(isMeaningful(t, 'normal')).toBe(true);
    }
    expect(isMeaningful('Read', 'normal')).toBe(false);
    expect(isMeaningful('Grep', 'normal')).toBe(false);
  });

  it('shows everything at verbose and nothing at silent', () => {
    expect(isMeaningful('Read', 'verbose')).toBe(true);
    expect(isMeaningful('Edit', 'silent')).toBe(false);
    expect(isMeaningful('Read', 'silent')).toBe(false);
  });
});

describe('activity row rendering', () => {
  it('renders an edit row with a pencil and the file path', () => {
    const input: ActivityInput = { toolName: 'Edit', toolInput: { file_path: 'src/app.ts', old_string: 'a', new_string: 'b' } };
    const row = renderActivityRow(input, ident);
    expect(row.icon).toBe('✏️');
    expect(row.summary).toContain('src/app.ts');
  });

  it('renders a bash row with a play glyph and the command', () => {
    const input: ActivityInput = { toolName: 'Bash', toolInput: { command: 'git status' } };
    const row = renderActivityRow(input, ident);
    expect(row.icon).toBe('▶️');
    expect(row.summary).toContain('git status');
  });

  it('redacts secrets in the row summary', () => {
    const input: ActivityInput = { toolName: 'Bash', toolInput: { command: 'curl -H token=topsecretABC' } };
    const row = renderActivityRow(input, mask);
    expect(row.summary).toContain('***');
    expect(row.summary).not.toContain('topsecretABC');
  });
});

describe('activity detail (Expand modal content)', () => {
  it('builds a unified diff for an Edit showing removed and added lines', () => {
    const input: ActivityInput = { toolName: 'Edit', toolInput: { file_path: 'src/app.ts', old_string: 'const x = 1', new_string: 'const x = 2' } };
    const detail = renderActivityDetail(input, ident);
    expect(detail.content).toContain('src/app.ts');
    expect(detail.content).toContain('-const x = 1');
    expect(detail.content).toContain('+const x = 2');
  });

  it('shows the exact command for a Bash detail', () => {
    const input: ActivityInput = { toolName: 'Bash', toolInput: { command: 'npm run build && echo done' } };
    const detail = renderActivityDetail(input, ident);
    expect(detail.content).toContain('npm run build && echo done');
  });

  it('redacts secrets in the detail content too', () => {
    const input: ActivityInput = { toolName: 'Write', toolInput: { file_path: '.env', content: 'KEY=topsecretXYZ' } };
    const detail = renderActivityDetail(input, mask);
    expect(detail.content).toContain('***');
    expect(detail.content).not.toContain('topsecretXYZ');
  });
});

function slackConfig(): SlackConfig {
  return { enabled: true, bot_token_env: 'AISUP_SLACK_BOT_TOKEN', app_token_env: 'AISUP_SLACK_APP_TOKEN',
    allowed_user_ids: ['U1'], relay_output_enabled: false, cmd_require_confirmation: false,
    redaction_patterns: [], interactivity_enabled: true };
}
/** Pull the request_id (button value) from a posted activity row. */
function rowRequestId(call: Record<string, unknown>): string | undefined {
  const blocks = (call.blocks ?? []) as Array<{ accessory?: { type?: string; value?: string } }>;
  for (const b of blocks) if (b.accessory?.type === 'button') return b.accessory.value;
  return undefined;
}

describe('SlackService activity feed (A4)', () => {
  let dir: string;
  function makeService(): SlackService {
    return new SlackService({
      config: slackConfig(),
      sessionManager: { getActiveSession: () => null, stopSession: async () => {} },
      tmuxSocket: 'sock',
      journal: { append: async () => {} },
      channelMapPath: join(dir, 'channel-map.json'),
      cardStorePath: join(dir, 'slack-cards.json'),
    });
  }
  async function start(svc: SlackService): Promise<void> {
    await svc.start();
    (svc as unknown as { channelMap: Map<string, string> }).channelMap.set('s1', 'C1');
  }
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'aisup-act-')); posted.length = 0; opened.length = 0; tsCounter = 0; });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('posts a threaded row for an Edit and a Bash, but none for a Read at normal', async () => {
    const svc = makeService();
    await start(svc);
    await svc.postActivity('s1', { toolName: 'Edit', toolInput: { file_path: 'src/app.ts', old_string: 'a', new_string: 'b' } });
    await svc.postActivity('s1', { toolName: 'Bash', toolInput: { command: 'git status' } });
    await svc.postActivity('s1', { toolName: 'Read', toolInput: { file_path: 'README.md' } });

    // 1 thread root + 2 rows (Edit, Bash); Read posts nothing.
    const rows = posted.filter((p) => p.thread_ts);
    expect(rows).toHaveLength(2);
    expect(JSON.stringify(rows)).toContain('src/app.ts');
    expect(JSON.stringify(rows)).toContain('git status');
    expect(JSON.stringify(rows)).not.toContain('README.md');
  });

  it('Expand on an edit row opens a modal with the unified diff', async () => {
    const svc = makeService();
    await start(svc);
    await svc.postActivity('s1', { toolName: 'Edit', toolInput: { file_path: 'src/app.ts', old_string: 'const x = 1', new_string: 'const x = 2' } });
    const reqId = rowRequestId(posted.find((p) => p.thread_ts)!);
    expect(reqId).toBeTruthy();

    await svc.handleAction(
      { type: 'block_actions', user: { id: 'U1' }, trigger_id: 'trig-1',
        actions: [{ action_id: ACTIVITY_EXPAND_ACTION, value: reqId }], channel: { id: 'C1' }, message: { ts: 'ts-2' } },
      vi.fn().mockResolvedValue(undefined),
    );
    expect(opened).toHaveLength(1);
    expect(JSON.stringify(opened[0])).toContain('-const x = 1');
    expect(JSON.stringify(opened[0])).toContain('+const x = 2');
  });
});
