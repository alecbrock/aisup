import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { appendEvent, createJournalWriter } from '../../src/journal/writer.js';
import type { JournalEvent } from '../../src/journal/types.js';

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

    await appendEvent(journalPath, event);

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

  it('should reject events with top-level secret key in details', async () => {
    const event: JournalEvent = {
      ts: new Date().toISOString(),
      event_type: 'daemon.started',
      details: { token: 'xoxb-secret' } as Record<string, unknown>,
    };

    await expect(appendEvent(journalPath, event)).rejects.toThrow(/secret.*key|forbidden.*key|token/i);
  });

  it('should reject events with nested secret key in details', async () => {
    const event: JournalEvent = {
      ts: new Date().toISOString(),
      event_type: 'slack.connection_error',
      details: { response: { authorization: 'Bearer xoxb-123' } } as Record<string, unknown>,
    };

    await expect(appendEvent(journalPath, event)).rejects.toThrow(/secret.*key|forbidden.*key|authorization/i);
  });

  it('should reject events with apiKey in deeply nested details', async () => {
    const event: JournalEvent = {
      ts: new Date().toISOString(),
      event_type: 'daemon.started',
      details: { a: { b: { apiKey: 'sk-123' } } } as Record<string, unknown>,
    };

    await expect(appendEvent(journalPath, event)).rejects.toThrow(/secret.*key|forbidden.*key|apiKey/i);
  });

  it('should allow events with safe keys that contain secret substrings in values (not keys)', async () => {
    const event: JournalEvent = {
      ts: new Date().toISOString(),
      event_type: 'daemon.started',
      details: { message: 'contains token word in value', reason: 'normal' },
    };

    await appendEvent(journalPath, event);
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
});
