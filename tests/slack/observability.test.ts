import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('../../src/session/tmux.js', () => ({
  sendInterrupt: vi.fn(), sendEnter: vi.fn(), sendText: vi.fn(),
  captureOutput: vi.fn().mockReturnValue(''), isProcessDead: vi.fn().mockReturnValue(false),
  createTmuxSession: vi.fn(), destroyTmuxSession: vi.fn(), stopPipePane: vi.fn(),
  startOutputLog: vi.fn(), listSessions: vi.fn().mockReturnValue([]),
}));
const posted: Array<Record<string, unknown>> = [];
let msgHandler: ((args: { message: Record<string, unknown>; say: (t: string) => Promise<void> }) => Promise<void>) | null = null;
vi.mock('@slack/bolt', () => {
  const FakeApp = vi.fn().mockImplementation(() => ({
    message: vi.fn().mockImplementation((fn) => { msgHandler = fn; }), action: vi.fn(), view: vi.fn(),
    start: vi.fn().mockResolvedValue(undefined), stop: vi.fn().mockResolvedValue(undefined),
    client: { auth: { test: vi.fn().mockResolvedValue({ ok: true }) },
      chat: { postMessage: vi.fn().mockImplementation((a) => { posted.push(a); return Promise.resolve({ ts: 't' }); }) } },
  }));
  return { App: FakeApp };
});

import { accountsBlocks, costBlocks, providersBlocks, healthBlocks } from '../../src/slack/observability.js';
import { SlackService } from '../../src/slack/service.js';
import type { AccountView } from '../../src/accounts/view.js';
import type { CostWindows } from '../../src/cost/aggregator.js';
import type { ProviderUsageReport } from '../../src/providers/report.js';

const acct = (over: Partial<AccountView> = {}): AccountView => ({
  name: 'primary', state: 'HEALTHY', priority: 1, enabled: true, score: 0.82,
  cooldown_until: null, five_hour_pct: 12, seven_day_pct: 34,
  five_hour_basis: 'ledger', seven_day_basis: 'ledger', model: 'opus', ...over,
});

describe('observability renderers (A6)', () => {
  it('accounts card shows name, state and 5h/7d headroom', () => {
    const s = JSON.stringify(accountsBlocks([acct(), acct({ name: 'work', enabled: false, five_hour_pct: null })]));
    expect(s).toContain('primary');
    expect(s).toContain('HEALTHY');
    expect(s).toContain('12%');
    expect(s).toContain('34%');
    expect(s).toContain('work');
    expect(s).toContain('disabled');
  });

  it('cost card shows today / 7d / 30d totals', () => {
    const cost: CostWindows = {
      today: { total_cost_usd: 1.5, by_account: {}, by_session: {} },
      last_7d: { total_cost_usd: 9.25, by_account: {}, by_session: {} },
      last_30d: { total_cost_usd: 40, by_account: {}, by_session: {} },
    };
    const s = JSON.stringify(costBlocks(cost));
    expect(s).toContain('$1.50');
    expect(s).toContain('$9.25');
    expect(s).toContain('$40.00');
  });

  it('providers card shows per-role candidate availability', () => {
    const report: ProviderUsageReport = {
      roles: [{ role: 'implementer', candidates: [
        { label: 'claude:primary', provider: 'claude', account: 'primary', available: true, headroom_pct: 88, remaining_tokens: null, basis: 'ledger' },
        { label: 'codex', provider: 'codex', account: null, available: false, headroom_pct: null, remaining_tokens: 0, basis: 'budget' },
      ] }],
    };
    const s = JSON.stringify(providersBlocks(report));
    expect(s).toContain('implementer');
    expect(s).toContain('claude:primary');
    expect(s).toContain('88%');
    expect(s).toContain('codex');
  });

  it('health card shows session, daemon, accounts and worker queue', () => {
    const s = JSON.stringify(healthBlocks({
      session: { id: 'sess-1', status: 'ACTIVE', account: 'primary' },
      daemonOk: true,
      workers: { queued: 2, running: 1, awaiting_approval: 0 },
      accounts: { total: 3, healthy: 2 },
    }));
    expect(s).toContain('sess-1');
    expect(s).toContain('ACTIVE');
    expect(s).toContain('2/3 healthy');
    expect(s).toContain('queued 2');
  });
});

describe('SlackService observability dispatch (A6)', () => {
  let dir: string;
  const say = vi.fn().mockResolvedValue(undefined);
  let svc: InstanceType<typeof SlackService>;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'aisup-obs-'));
    posted.length = 0; say.mockClear();
    svc = new SlackService({
      config: { enabled: true, bot_token_env: 'AISUP_SLACK_BOT_TOKEN', app_token_env: 'AISUP_SLACK_APP_TOKEN',
        allowed_user_ids: ['U1'], relay_output_enabled: false, cmd_require_confirmation: false,
        redaction_patterns: [], interactivity_enabled: true },
      sessionManager: { getActiveSession: () => null, stopSession: async () => {} },
      tmuxSocket: 'sock',
      journal: { append: async () => {} },
      channelMapPath: join(dir, 'channel-map.json'),
      cardStorePath: join(dir, 'slack-cards.json'),
      getAccountsView: () => [acct()],
      getCostView: () => ({ today: { total_cost_usd: 3, by_account: {}, by_session: {} },
        last_7d: { total_cost_usd: 5, by_account: {}, by_session: {} },
        last_30d: { total_cost_usd: 7, by_account: {}, by_session: {} } }),
      getWorkerProvidersView: () => ({ roles: [{ role: 'implementer', candidates: [
        { label: 'claude:primary', provider: 'claude', account: 'primary', available: true, headroom_pct: 90, remaining_tokens: null, basis: 'ledger' }] }] }),
      getHealthView: () => ({ session: { id: null, status: null, account: null }, daemonOk: true,
        workers: null, accounts: { total: 1, healthy: 1 } }),
    });
    await svc.start();
    (svc as unknown as { channelMap: Map<string, string> }).channelMap.set('s1', 'C1');
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  async function cmd(text: string): Promise<void> {
    await msgHandler!({ message: { text, user: 'U1', channel: 'C1' }, say });
  }

  it('!accounts posts an accounts card', async () => {
    await cmd('!accounts');
    expect(JSON.stringify(posted)).toContain('primary');
  });
  it('!cost posts a cost card', async () => {
    await cmd('!cost');
    expect(JSON.stringify(posted)).toContain('$3.00');
  });
  it('!worker providers posts a providers card', async () => {
    await cmd('!worker providers');
    expect(JSON.stringify(posted)).toContain('implementer');
  });
  it('!health posts a health card', async () => {
    await cmd('!health');
    expect(JSON.stringify(posted)).toContain('1/1 healthy');
  });
});
