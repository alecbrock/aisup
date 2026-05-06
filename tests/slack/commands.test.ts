import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseCommand, ConfirmationStore } from '../../src/slack/commands.js';

describe('parseCommand', () => {
  it('should parse !interrupt', () => {
    const cmd = parseCommand('!interrupt');
    expect(cmd?.name).toBe('interrupt');
    expect(cmd?.args).toBe('');
  });

  it('should parse !stop', () => {
    expect(parseCommand('!stop')?.name).toBe('stop');
  });

  it('should parse !status', () => {
    expect(parseCommand('!status')?.name).toBe('status');
  });

  it('should parse !cmd with args', () => {
    const cmd = parseCommand('!cmd /clear');
    expect(cmd?.name).toBe('cmd');
    expect(cmd?.args).toBe('/clear');
  });

  it('should parse !relay on', () => {
    const cmd = parseCommand('!relay on');
    expect(cmd?.name).toBe('relay');
    expect(cmd?.args).toBe('on');
  });

  it('should parse !relay off', () => {
    expect(parseCommand('!relay off')?.args).toBe('off');
  });

  it('should parse !help', () => {
    expect(parseCommand('!help')?.name).toBe('help');
  });

  it('should parse !confirm', () => {
    expect(parseCommand('!confirm')?.name).toBe('confirm');
  });

  it('should return null for non-command messages', () => {
    expect(parseCommand('hello world')).toBeNull();
  });

  it('should return unknown for unrecognized ! commands', () => {
    const cmd = parseCommand('!foobar');
    expect(cmd?.name).toBe('unknown');
  });

  it('should handle extra whitespace in args', () => {
    const cmd = parseCommand('!cmd   /spec some args   ');
    expect(cmd?.args).toBe('/spec some args');
  });
});

describe('ConfirmationStore', () => {
  let store: ConfirmationStore;

  beforeEach(() => {
    store = new ConfirmationStore(60000); // 60s TTL
    vi.useFakeTimers();
  });

  it('should store a pending confirmation', () => {
    store.set('C1', 'U1', 'stop', 'session-stop');
    expect(store.get('C1', 'U1', 'stop')).not.toBeNull();
  });

  it('should return null for non-existent confirmation', () => {
    expect(store.get('C1', 'U1', 'stop')).toBeNull();
  });

  it('should expire after TTL', () => {
    store.set('C1', 'U1', 'stop', 'session-stop');
    vi.advanceTimersByTime(61000);
    expect(store.get('C1', 'U1', 'stop')).toBeNull();
  });

  it('should clear after retrieval', () => {
    store.set('C1', 'U1', 'cmd', 'some text');
    store.get('C1', 'U1', 'cmd');
    expect(store.get('C1', 'U1', 'cmd')).toBeNull();
  });

  it('should be keyed by channel+user+action (different actions do not collide)', () => {
    store.set('C1', 'U1', 'stop', 'stop-payload');
    store.set('C1', 'U1', 'cmd', 'cmd-payload');
    expect(store.get('C1', 'U1', 'stop')?.payload).toBe('stop-payload');
    expect(store.get('C1', 'U1', 'cmd')?.payload).toBe('cmd-payload');
  });

  it('should overwrite previous pending confirmation for same key', () => {
    store.set('C1', 'U1', 'cmd', 'first');
    store.set('C1', 'U1', 'cmd', 'second');
    expect(store.get('C1', 'U1', 'cmd')?.payload).toBe('second');
  });
});
