import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { appendEvent, createJournalWriter } from '../../src/journal/writer.js';
import type { JournalEvent, EventType } from '../../src/journal/types.js';

describe('appendEvent', () => {
  let tmpDir: string;
  let journalPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'aisup-journal-'));
    journalPath = join(tmpDir, 'journal.jsonl');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should write a valid JSONL line to the configured path', async () => {
    const event: JournalEvent = {
      ts: new Date().toISOString(),
      event_type: 'daemon.started',
      details: { version: '0.1.0' },
    };

    const result = await appendEvent(journalPath, event);
    expect(result.ok).toBe(true);

    const content = readFileSync(journalPath, 'utf8');
    const lines = content.trim().split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);

    const parsed = JSON.parse(lines[0]);
    expect(parsed.event_type).toBe('daemon.started');
    expect(parsed.ts).toBe(event.ts);
    expect(parsed.details.version).toBe('0.1.0');
  });

  it('should append multiple events as separate JSONL lines', async () => {
    const events: JournalEvent[] = [
      { ts: new Date().toISOString(), event_type: 'daemon.started', details: {} },
      { ts: new Date().toISOString(), event_type: 'daemon.ready', details: {} },
    ];

    await appendEvent(journalPath, events[0]);
    await appendEvent(journalPath, events[1]);

    const content = readFileSync(journalPath, 'utf8');
    const lines = content.trim().split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).event_type).toBe('daemon.started');
    expect(JSON.parse(lines[1]).event_type).toBe('daemon.ready');
  });

  it('should auto-create journal directory if missing', async () => {
    const deepPath = join(tmpDir, 'nested', 'dir', 'journal.jsonl');
    const event: JournalEvent = {
      ts: new Date().toISOString(),
      event_type: 'daemon.started',
      details: {},
    };

    await appendEvent(deepPath, event);

    const content = readFileSync(deepPath, 'utf8');
    expect(JSON.parse(content.trim())).toBeTruthy();
  });

  // AF-301: a forbidden secret key is reported via {ok:false}, NOT a throw — and the offending event
  // is still never written (security guarantee preserved). A throw here would crash the daemon from
  // the ~9 fire-and-forget `void journal.append(...)` sites.
  it('rejects (without throwing) and does not write an event with a top-level secret key', async () => {
    const event: JournalEvent = {
      ts: new Date().toISOString(),
      event_type: 'daemon.started',
      details: { token: 'xoxb-secret' } as Record<string, unknown>,
    };

    const result = await appendEvent(journalPath, event);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/forbidden.*key|token/i);
    expect(existsSync(journalPath)).toBe(false);
  });

  it('rejects (without throwing) a nested secret key', async () => {
    const event: JournalEvent = {
      ts: new Date().toISOString(),
      event_type: 'slack.connection_error',
      details: { response: { authorization: 'Bearer xoxb-123' } } as Record<string, unknown>,
    };

    const result = await appendEvent(journalPath, event);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/forbidden.*key|authorization/i);
    expect(existsSync(journalPath)).toBe(false);
  });

  it('rejects (without throwing) an apiKey in deeply nested details', async () => {
    const event: JournalEvent = {
      ts: new Date().toISOString(),
      event_type: 'daemon.started',
      details: { a: { b: { apiKey: 'sk-123' } } } as Record<string, unknown>,
    };

    const result = await appendEvent(journalPath, event);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/forbidden.*key|apiKey/i);
    expect(existsSync(journalPath)).toBe(false);
  });

  it('should allow events with safe keys that contain secret substrings in values (not keys)', async () => {
    const event: JournalEvent = {
      ts: new Date().toISOString(),
      event_type: 'daemon.started',
      details: { message: 'contains token word in value', reason: 'normal' },
    };

    const result = await appendEvent(journalPath, event);
    expect(result.ok).toBe(true);
    const content = readFileSync(journalPath, 'utf8');
    expect(JSON.parse(content.trim()).details.message).toContain('token');
  });

  it('should create journal writer with bound path', async () => {
    const writer = createJournalWriter(journalPath);
    const event: JournalEvent = {
      ts: new Date().toISOString(),
      event_type: 'daemon.ready',
      details: {},
    };

    await writer.append(event);

    const content = readFileSync(journalPath, 'utf8');
    expect(JSON.parse(content.trim()).event_type).toBe('daemon.ready');
  });

  it('rejects (without throwing) api_key (underscore variant)', async () => {
    const event: JournalEvent = {
      ts: new Date().toISOString(),
      event_type: 'daemon.started',
      details: { api_key: 'sk-secret-123' } as Record<string, unknown>,
    };
    const result = await appendEvent(journalPath, event);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/forbidden.*key/i);
    expect(existsSync(journalPath)).toBe(false);
  });

  it('rejects (without throwing) bot_token', async () => {
    const event: JournalEvent = {
      ts: new Date().toISOString(),
      event_type: 'slack.connection_error',
      details: { bot_token: 'xoxb-123' } as Record<string, unknown>,
    };
    const result = await appendEvent(journalPath, event);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/forbidden.*key/i);
    expect(existsSync(journalPath)).toBe(false);
  });

  it('rejects (without throwing) a secret key inside an array', async () => {
    const event: JournalEvent = {
      ts: new Date().toISOString(),
      event_type: 'daemon.started',
      details: { items: [{ token: 'leaked' }] } as Record<string, unknown>,
    };
    const result = await appendEvent(journalPath, event);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/forbidden.*key/i);
    expect(existsSync(journalPath)).toBe(false);
  });

  it('should include optional fields when provided', async () => {
    const event: JournalEvent = {
      ts: new Date().toISOString(),
      event_type: 'session.start',
      aisup_session_id: 'aisup-abc12345',
      claude_session_id: 'claude-xyz789',
      account: 'primary',
      details: { cwd: '/some/project' },
      tokens: 1000,
      cost_usd: 0.05,
    };

    await appendEvent(journalPath, event);

    const parsed = JSON.parse(readFileSync(journalPath, 'utf8').trim());
    expect(parsed.aisup_session_id).toBe('aisup-abc12345');
    expect(parsed.claude_session_id).toBe('claude-xyz789');
    expect(parsed.account).toBe('primary');
    expect(parsed.tokens).toBe(1000);
    expect(parsed.cost_usd).toBe(0.05);
  });

  it('accepts all worker.* event types with safe details', async () => {
    const workerEvents: EventType[] = [
      'worker.queued', 'worker.dispatched', 'worker.completed', 'worker.failed',
      'worker.validated', 'worker.validation_failed', 'worker.review_started',
      'worker.review_passed', 'worker.review_failed', 'worker.review_degraded',
      'worker.awaiting_approval', 'worker.approved', 'worker.denied',
      'worker.merge_started', 'worker.merged', 'worker.merge_failed',
      'worker.boundary_violation', 'worker.security_denied', 'worker.cancelled',
      'worker.cleanup', 'worker.rehydrated_failed', 'worker.rehydrated_merged',
    ];
    for (const event_type of workerEvents) {
      await appendEvent(journalPath, {
        ts: new Date().toISOString(),
        event_type,
        details: { worker_task_id: 'w-1', reason: 'ok' },
      });
    }
    const lines = readFileSync(journalPath, 'utf8').trim().split('\n').filter(Boolean);
    expect(lines).toHaveLength(workerEvents.length);
    expect(JSON.parse(lines[0]).event_type).toBe('worker.queued');
  });

  it('still refuses a secret key inside a worker event (no throw, not written)', async () => {
    const result = await appendEvent(journalPath, {
      ts: new Date().toISOString(),
      event_type: 'worker.security_denied',
      details: { bot_token: 'xoxb-leak' } as Record<string, unknown>,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/forbidden.*key/i);
    expect(existsSync(journalPath)).toBe(false);
  });

  // AF-301: a write failure (ENOSPC class — here, a path whose parent is a regular file) must be
  // reported as {ok:false}, never thrown — otherwise it crashes the daemon from a void site.
  it('returns {ok:false} (does not throw) when the write fails', async () => {
    const filePath = join(tmpDir, 'not-a-dir');
    writeFileSync(filePath, 'x');
    const badPath = join(filePath, 'journal.jsonl'); // parent is a file → mkdir/append fails

    const result = await appendEvent(badPath, {
      ts: new Date().toISOString(),
      event_type: 'daemon.started',
      details: {},
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBeTruthy();
  });

  // AF-325: a secret stored under an innocuous KEY name (so the key scan misses it) must still be
  // caught by the value scan and not written.
  it('rejects (without throwing) a vendor-prefixed secret VALUE under a safe key (ghp_)', async () => {
    const event: JournalEvent = {
      ts: new Date().toISOString(),
      event_type: 'daemon.started',
      details: { note: 'pushed with ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789' } as Record<string, unknown>,
    };
    const result = await appendEvent(journalPath, event);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/forbidden secret value/i);
    expect(existsSync(journalPath)).toBe(false);
  });

  it('rejects a Stripe-style sk_ secret value nested under a safe key', async () => {
    const event: JournalEvent = {
      ts: new Date().toISOString(),
      event_type: 'daemon.started',
      details: { meta: { config: 'key=sk_live_0123456789abcdefghij' } } as Record<string, unknown>,
    };
    const result = await appendEvent(journalPath, event);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/forbidden secret value/i);
  });

  it('does not false-positive on ordinary values containing short prefixes (e.g. "task_id", "workspace-write")', async () => {
    const event: JournalEvent = {
      ts: new Date().toISOString(),
      event_type: 'daemon.started',
      details: { args: ['exec', '--json', '-s', 'workspace-write'], note: 'task_id sk_1 done' },
    };
    const result = await appendEvent(journalPath, event);
    expect(result.ok).toBe(true);
  });

  it('createJournalWriter().append resolves (never rejects) even when the write fails — void sites cannot crash the daemon', async () => {
    const filePath = join(tmpDir, 'not-a-dir2');
    writeFileSync(filePath, 'x');
    const writer = createJournalWriter(join(filePath, 'journal.jsonl'));

    await expect(
      writer.append({ ts: new Date().toISOString(), event_type: 'daemon.started', details: {} })
    ).resolves.toBeUndefined();
  });
});
