import type { NtfyConfig } from '../config/schema.js';
import type { JournalWriter } from '../journal/types.js';

/** A push-worthy notification to mirror to ntfy (D2). */
export interface NtfyEvent {
  title: string;
  message: string;
  priority?: 'min' | 'low' | 'default' | 'high' | 'urgent';
  tags?: string[];
}

export interface NtfyEmitterDeps {
  config: NtfyConfig | undefined;
  journal: JournalWriter;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * Build a best-effort ntfy emitter. When `config.enabled` + a topic are set, each event is POSTed to
 * `<server>/<topic>` (title/priority/tags as ntfy headers, message as the body). Notification-only —
 * failures are journaled as `notification.ntfy_failed`, never thrown (Slack stays the control plane).
 */
export function createNtfyEmitter(deps: NtfyEmitterDeps): (event: NtfyEvent) => Promise<void> {
  const doFetch = deps.fetchImpl ?? fetch;
  return async (event: NtfyEvent): Promise<void> => {
    const cfg = deps.config;
    if (!cfg?.enabled || !cfg.topic) return; // disabled or unconfigured → no POST
    const base = cfg.server.replace(/\/+$/, '');
    const url = `${base}/${cfg.topic}`;
    const headers: Record<string, string> = { Title: event.title };
    if (event.priority) headers.Priority = event.priority;
    if (event.tags && event.tags.length) headers.Tags = event.tags.join(',');
    try {
      const res = await doFetch(url, { method: 'POST', headers, body: event.message });
      if (!res.ok) await journalFailure(deps.journal, `ntfy responded ${res.status}`, event.title);
    } catch (err) {
      await journalFailure(deps.journal, err instanceof Error ? err.message : String(err), event.title);
    }
  };
}

async function journalFailure(journal: JournalWriter, reason: string, title: string): Promise<void> {
  try {
    await journal.append({
      ts: new Date().toISOString(),
      event_type: 'notification.ntfy_failed',
      details: { reason, title },
    });
  } catch { /* the journal itself is best-effort here — never let notification failure crash the daemon */ }
}
