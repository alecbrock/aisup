import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, symlinkSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { migrateTranscript, MigrationResult, MigrationError } from '../../src/failover/migrator.js';

const CLAUDE_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const CONTENT = '{"role":"user","content":"hello"}\n{"role":"assistant","content":"world"}\n';

describe('migrateTranscript', () => {
  let tmpDir: string;
  let sourceConfigDir: string;
  let targetConfigDir: string;
  let projectsDir: string;
  let transcriptPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'aisup-migrator-'));
    sourceConfigDir = join(tmpDir, '.claude');
    targetConfigDir = join(tmpDir, '.claude-account2');
    projectsDir = join(sourceConfigDir, 'projects', '-Users-alec-Projects-foo');
    mkdirSync(projectsDir, { recursive: true });
    mkdirSync(join(targetConfigDir, 'projects', '-Users-alec-Projects-foo'), { recursive: true });
    transcriptPath = join(projectsDir, `${CLAUDE_ID}.jsonl`);
    writeFileSync(transcriptPath, CONTENT);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should copy transcript to target account project dir', async () => {
    const result = await migrateTranscript({
      transcriptPath,
      sourceConfigDir,
      targetConfigDir,
      claudeSessionId: CLAUDE_ID,
    });

    expect(result.status).toBe('copied');
    expect(result.targetPath).toContain(targetConfigDir);
    expect(result.targetPath).toMatch(new RegExp(`${CLAUDE_ID}\\.jsonl$`));
    expect(existsSync(result.targetPath!)).toBe(true);
    expect(readFileSync(result.targetPath!, 'utf8')).toBe(CONTENT);
  });

  it('should verify SHA-256 integrity of copied file', async () => {
    const result = await migrateTranscript({
      transcriptPath,
      sourceConfigDir,
      targetConfigDir,
      claudeSessionId: CLAUDE_ID,
    });

    expect(result.sourceSha256).toBeDefined();
    expect(result.targetSha256).toBe(result.sourceSha256);
  });

  it('should skip when destination already matches source (idempotent)', async () => {
    // First migration
    await migrateTranscript({ transcriptPath, sourceConfigDir, targetConfigDir, claudeSessionId: CLAUDE_ID });
    // Second migration — should skip
    const result = await migrateTranscript({ transcriptPath, sourceConfigDir, targetConfigDir, claudeSessionId: CLAUDE_ID });

    expect(result.status).toBe('already_migrated');
  });

  it('should rename aside and recopy when destination exists but differs', async () => {
    const targetPath = join(targetConfigDir, 'projects', '-Users-alec-Projects-foo', `${CLAUDE_ID}.jsonl`);
    writeFileSync(targetPath, 'stale content\n');

    const result = await migrateTranscript({ transcriptPath, sourceConfigDir, targetConfigDir, claudeSessionId: CLAUDE_ID });

    expect(result.status).toBe('collision_renamed');
    expect(readFileSync(targetPath, 'utf8')).toBe(CONTENT);
  });

  it('should reject symlinked transcript source', async () => {
    const linkPath = join(projectsDir, 'link.jsonl');
    symlinkSync(transcriptPath, linkPath);

    await expect(
      migrateTranscript({ transcriptPath: linkPath, sourceConfigDir, targetConfigDir, claudeSessionId: null })
    ).rejects.toThrow(/symlink/i);
  });

  it('should reject path traversal in transcript path', async () => {
    // File outside sourceConfigDir entirely
    const evilPath = join(tmpDir, 'evil.jsonl');
    writeFileSync(evilPath, CONTENT);

    await expect(
      migrateTranscript({ transcriptPath: evilPath, sourceConfigDir, targetConfigDir, claudeSessionId: null })
    ).rejects.toThrow(/traversal|outside|not under/i);
  });

  it('should reject non-.jsonl files', async () => {
    const nonJsonl = join(projectsDir, 'config.yaml');
    writeFileSync(nonJsonl, 'yaml: true');

    await expect(
      migrateTranscript({ transcriptPath: nonJsonl, sourceConfigDir, targetConfigDir, claudeSessionId: null })
    ).rejects.toThrow(/\.jsonl/i);
  });

  it('should reject files outside projects/ subdirectory', async () => {
    // .jsonl file inside configDir but NOT under projects/
    const outsidePath = join(sourceConfigDir, `${CLAUDE_ID}.jsonl`);
    writeFileSync(outsidePath, CONTENT);

    await expect(
      migrateTranscript({ transcriptPath: outsidePath, sourceConfigDir, targetConfigDir, claudeSessionId: null })
    ).rejects.toThrow(/projects\//i);
  });

  it('should reject basename UUID mismatch when claudeSessionId is provided', async () => {
    const wrongId = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
    const wrongPath = join(projectsDir, `${wrongId}.jsonl`);
    writeFileSync(wrongPath, CONTENT);

    await expect(
      migrateTranscript({ transcriptPath: wrongPath, sourceConfigDir, targetConfigDir, claudeSessionId: CLAUDE_ID })
    ).rejects.toThrow(/UUID mismatch|basename/i);
  });

  it('should reject symlinked target parent component', async () => {
    const realDir = join(tmpDir, 'real-target');
    mkdirSync(join(realDir, 'projects', '-Users-alec-Projects-foo'), { recursive: true });
    const symlinkTarget = join(tmpDir, '.claude-symlinked');
    symlinkSync(realDir, symlinkTarget);

    await expect(
      migrateTranscript({
        transcriptPath,
        sourceConfigDir,
        targetConfigDir: symlinkTarget,
        claudeSessionId: CLAUDE_ID,
      })
    ).rejects.toThrow(/symlink.*target parent/i);
  });

  it('should allow any uuid filename when claudeSessionId is null', async () => {
    const result = await migrateTranscript({
      transcriptPath,
      sourceConfigDir,
      targetConfigDir,
      claudeSessionId: null,
    });

    expect(result.status).toBe('copied');
  });

  it('returns sourceSize equal to the source file byte length', async () => {
    const result = await migrateTranscript({
      transcriptPath,
      sourceConfigDir,
      targetConfigDir,
      claudeSessionId: CLAUDE_ID,
    });
    expect(result.sourceSize).toBe(Buffer.byteLength(CONTENT));
  });

  it('throws a typed MigrationError with a safe reason enum for rejections', async () => {
    // symlink source
    const linkPath = join(projectsDir, 'link.jsonl');
    symlinkSync(transcriptPath, linkPath);
    await expect(
      migrateTranscript({ transcriptPath: linkPath, sourceConfigDir, targetConfigDir, claudeSessionId: null })
    ).rejects.toMatchObject({ reason: 'symlink_rejected' });

    // wrong extension
    const nonJsonl = join(projectsDir, 'config.yaml');
    writeFileSync(nonJsonl, 'yaml: true');
    await expect(
      migrateTranscript({ transcriptPath: nonJsonl, sourceConfigDir, targetConfigDir, claudeSessionId: null })
    ).rejects.toMatchObject({ reason: 'wrong_extension' });

    // basename mismatch
    const wrongId = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
    const wrongPath = join(projectsDir, `${wrongId}.jsonl`);
    writeFileSync(wrongPath, CONTENT);
    const err = await migrateTranscript({ transcriptPath: wrongPath, sourceConfigDir, targetConfigDir, claudeSessionId: CLAUDE_ID })
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(MigrationError);
    expect((err as MigrationError).reason).toBe('basename_mismatch');
  });
});
