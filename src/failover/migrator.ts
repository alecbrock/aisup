import {
  lstatSync,
  realpathSync,
  createReadStream,
  createWriteStream,
  renameSync,
  mkdirSync,
  openSync,
  fsyncSync,
  closeSync,
  existsSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative, basename, dirname, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';

export interface MigrateOpts {
  transcriptPath: string;
  sourceConfigDir: string;
  targetConfigDir: string;
  claudeSessionId: string | null;
}

export interface MigrationResult {
  status: 'copied' | 'already_migrated' | 'collision_renamed' | 'skipped_no_transcript';
  targetPath?: string;
  sourceSha256?: string;
  targetSha256?: string;
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

async function atomicCopy(src: string, dest: string): Promise<string> {
  const tmp = `${dest}.tmp.${Date.now()}`;
  const wfd = openSync(tmp, 'w', 0o600);
  try {
    await pipeline(createReadStream(src), createWriteStream(tmp, { fd: wfd, autoClose: false }));
    fsyncSync(wfd);
  } finally {
    closeSync(wfd);
  }
  renameSync(tmp, dest);
  return dest;
}

export async function migrateTranscript(opts: MigrateOpts): Promise<MigrationResult> {
  const { transcriptPath, sourceConfigDir, targetConfigDir, claudeSessionId } = opts;

  // Validate source — reject symlinks
  let srcStat;
  try {
    srcStat = lstatSync(transcriptPath);
  } catch {
    throw new Error(`migrateTranscript: source file not found: ${transcriptPath}`);
  }
  if (srcStat.isSymbolicLink()) {
    throw new Error(`migrateTranscript: symlink rejected: ${transcriptPath}`);
  }
  if (!srcStat.isFile()) {
    throw new Error(`migrateTranscript: not a regular file: ${transcriptPath}`);
  }

  const resolvedSrc = realpathSync(transcriptPath);
  const resolvedSrcDir = realpathSync(resolve(sourceConfigDir));

  // Must be under source config dir
  if (!resolvedSrc.startsWith(resolvedSrcDir + '/')) {
    throw new Error(
      `migrateTranscript: path traversal — ${resolvedSrc} is not under ${resolvedSrcDir}`
    );
  }

  // Must be .jsonl
  if (!resolvedSrc.endsWith('.jsonl')) {
    throw new Error(`migrateTranscript: file must be .jsonl, got ${resolvedSrc}`);
  }

  // Must be under projects/ subdirectory
  const rel = relative(resolvedSrcDir, resolvedSrc);
  if (!rel.startsWith('projects/')) {
    throw new Error(`migrateTranscript: file must be under projects/ subdirectory, got ${rel}`);
  }

  // UUID basename must match claudeSessionId when known
  if (claudeSessionId !== null) {
    const fileBasename = basename(resolvedSrc, '.jsonl');
    if (fileBasename !== claudeSessionId) {
      throw new Error(
        `migrateTranscript: basename UUID mismatch — file is ${fileBasename}, expected ${claudeSessionId}`
      );
    }
  }

  const resolvedTargetDir = realpathSync(resolve(targetConfigDir));
  const targetPath = join(resolvedTargetDir, rel);

  // Validate no target path traversal
  if (!targetPath.startsWith(resolvedTargetDir + '/')) {
    throw new Error(`migrateTranscript: target path traversal detected`);
  }

  mkdirSync(dirname(targetPath), { recursive: true, mode: 0o700 });

  const sourceSha256 = await sha256File(resolvedSrc);

  // Handle existing destination
  if (existsSync(targetPath)) {
    const destStat = lstatSync(targetPath);
    if (destStat.isSymbolicLink()) {
      throw new Error(`migrateTranscript: symlink at target path rejected`);
    }
    if (!destStat.isFile()) {
      throw new Error(`migrateTranscript: non-regular file at target path`);
    }
    const destSha256 = await sha256File(targetPath);
    if (destSha256 === sourceSha256 && destStat.size === srcStat.size) {
      return { status: 'already_migrated', targetPath, sourceSha256, targetSha256: destSha256 };
    }
    // Collision — rename aside and recopy
    const bakPath = `${targetPath}.bak.${Date.now()}`;
    renameSync(targetPath, bakPath);
    await atomicCopy(resolvedSrc, targetPath);
    const targetSha256 = await sha256File(targetPath);
    return { status: 'collision_renamed', targetPath, sourceSha256, targetSha256 };
  }

  await atomicCopy(resolvedSrc, targetPath);
  const targetSha256 = await sha256File(targetPath);

  if (targetSha256 !== sourceSha256) {
    throw new Error(`migrateTranscript: integrity check failed — SHA-256 mismatch after copy`);
  }

  return { status: 'copied', targetPath, sourceSha256, targetSha256 };
}
