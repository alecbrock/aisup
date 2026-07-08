import type { KnownBlock } from '@slack/types';
import { statusBlocks } from './blocks.js';
import type { AccountView } from '../accounts/view.js';
import type { CostWindows } from '../cost/aggregator.js';
import type { ProviderUsageReport } from '../providers/report.js';

/**
 * Pure Block Kit renderers for the read-only Slack observability commands (A6). They consume the
 * SAME view data as the HTTP API / CLI (`buildAccountsView`, `aggregateCosts`, the provider report),
 * so `!accounts` / `!cost` / `!worker providers` / `!health` report numbers identical to the CLI.
 */

function pct(v: number | null): string {
  return typeof v === 'number' ? `${Math.round(v)}%` : '—';
}

export function accountsBlocks(accounts: AccountView[]): KnownBlock[] {
  if (accounts.length === 0) return statusBlocks({ title: 'Accounts', lines: ['No accounts configured.'] });
  const lines = accounts.map((a) =>
    `*${a.name}* — ${a.state}${a.enabled ? '' : ' _(disabled)_'} · 5h ${pct(a.five_hour_pct)} · 7d ${pct(a.seven_day_pct)}` +
    (typeof a.score === 'number' ? ` · score ${a.score.toFixed(2)}` : ''));
  return statusBlocks({ title: 'Accounts', lines });
}

export function costBlocks(cost: CostWindows): KnownBlock[] {
  const fmt = (n: number): string => `$${n.toFixed(2)}`;
  const lines = [
    `Today: ${fmt(cost.today.total_cost_usd)}`,
    `Last 7d: ${fmt(cost.last_7d.total_cost_usd)}`,
    `Last 30d: ${fmt(cost.last_30d.total_cost_usd)}`,
  ];
  return statusBlocks({ title: 'Cost', lines });
}

export function providersBlocks(report: ProviderUsageReport): KnownBlock[] {
  if (report.roles.length === 0) return statusBlocks({ title: 'Worker providers', lines: ['No worker roles configured.'] });
  const lines: string[] = [];
  for (const role of report.roles) {
    lines.push(`*${role.role}*`);
    for (const c of role.candidates) {
      const signal = c.headroom_pct != null ? `${pct(c.headroom_pct)} headroom`
        : c.remaining_tokens != null ? `${c.remaining_tokens} tok` : '';
      lines.push(`  ${c.available ? '✅' : '🚫'} ${c.label}${signal ? ` · ${signal}` : ''} _(${c.basis})_`);
    }
  }
  return statusBlocks({ title: 'Worker providers', lines });
}

export interface HealthView {
  session: { id: string | null; status: string | null; account: string | null };
  daemonOk: boolean;
  workers: { queued: number; running: number; awaiting_approval: number } | null;
  accounts: { total: number; healthy: number };
}

export function healthBlocks(h: HealthView): KnownBlock[] {
  const lines = [
    h.session.id
      ? `Session: \`${h.session.id}\` [${h.session.status ?? '?'}] @ ${h.session.account ?? '?'}`
      : 'Session: _none active_',
    `Daemon: ${h.daemonOk ? ':large_green_circle: ok' : ':red_circle: down'}`,
    `Accounts: ${h.accounts.healthy}/${h.accounts.total} healthy`,
  ];
  if (h.workers) {
    lines.push(`Workers: queued ${h.workers.queued} · running ${h.workers.running} · awaiting ${h.workers.awaiting_approval}`);
  }
  return statusBlocks({ title: 'Health', lines });
}
