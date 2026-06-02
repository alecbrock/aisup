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
  unlinkSync,
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

/** Safe, enumerable reasons a migration was rejected — never raw exception text. */
export type MigrationRejectReason =
  | 'source_not_found'
  | 'symlink_rejected'
  | 'not_regular_file'
  | 'outside_source_dir'
  | 'wrong_extension'
  | 'not_under_projects'
  | 'basename_mismatch'
  | 'target_parent_symlink'
  | 'target_path_traversal'
  | 'target_symlink'
  | 'target_non_regular'
  | 'byte_count_mismatch'
  | 'integrity_check_failed';

/** Thrown on a rejected migration; carries a safe `reason` enum for journal events. */
export class MigrationError extends Error {
  readonly reason: MigrationRejectReason;
  constructor(reason: MigrationRejectReason, message: string) {
    super(message);
    this.name = 'MigrationError';
    this.reason = reason;
  }
}

export interface MigrationResult {
  status: 'copied' | 'already_migrated' | 'collision_renamed' | 'skipped_no_transcript';
  targetPath?: string;
  sourceSha256?: string;
  targetSha256?: string;
  sourceSize?: number;
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

function validateTargetParentComponents(targetPath: string, resolvedTargetDir: string): void {
  let current = dirname(targetPath);
  while (current !== resolvedTargetDir && current.length > resolvedTargetDir.length) {
    const stat = lstatSync(current, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink()) {
      throw new MigrationError(
        'target_parent_symlink',
        `migrateTranscript: symlinked target parent component rejected: ${current}`
      );
    }
    current = dirname(current);
  }
}

async function atomicCopy(src: string, dest: string): Promise<{ destPath: string; bytesCopied: number }> {
  const tmp = `${dest}.tmp.${Date.now()}.${process.pid}`;
  const wfd = openSync(tmp, 'wx', 0o600);
  let bytesCopied = 0;
  try {
    const rs = createReadStream(src);
    const ws = createWriteStream(tmp, { fd: wfd, autoClose: false });
    rs.on('data', (chunk: Buffer | string) => { bytesCopied += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length; });
    await pipeline(rs, ws);
    fsyncSync(wfd);
  } catch (err) {
    closeSync(wfd);
    try { unlinkSync(tmp); } catch { /* best effort */ }
    throw err;
  }
  closeSync(wfd);
  renameSync(tmp, dest);
  return { destPath: dest, bytesCopied };
}

export async function migrateTranscript(opts: MigrateOpts): Promise<MigrationResult> {
  const { transcriptPath, sourceConfigDir, targetConfigDir, claudeSessionId } = opts;

  // Validate source — reject symlinks
  let srcStat;
  try {
    srcStat = lstatSync(transcriptPath);
  } catch {
    throw new MigrationError('source_not_found', `migrateTranscript: source file not found: ${transcriptPath}`);
  }
  if (srcStat.isSymbolicLink()) {
    throw new MigrationError('symlink_rejected', `migrateTranscript: symlink rejected: ${transcriptPath}`);
  }
  if (!srcStat.isFile()) {
    throw new MigrationError('not_regular_file', `migrateTranscript: not a regular file: ${transcriptPath}`);
  }

  const resolvedSrc = realpathSync(transcriptPath);
  const resolvedSrcDir = realpathSync(resolve(sourceConfigDir));

  // Must be under source config dir
  if (!resolvedSrc.startsWith(resolvedSrcDir + '/')) {
    throw new MigrationError(
      'outside_source_dir',
      `migrateTranscript: path traversal — ${resolvedSrc} is not under ${resolvedSrcDir}`
    );
  }

  // Must be .jsonl
  if (!resolvedSrc.endsWith('.jsonl')) {
    throw new MigrationError('wrong_extension', `migrateTranscript: file must be .jsonl, got ${resolvedSrc}`);
  }

  // Must be under projects/ subdirectory
  const rel = relative(resolvedSrcDir, resolvedSrc);
  if (!rel.startsWith('projects/')) {
    throw new MigrationError('not_under_projects', `migrateTranscript: file must be under projects/ subdirectory, got ${rel}`);
  }

  // UUID basename must match claudeSessionId when known
  if (claudeSessionId !== null) {
    const fileBasename = basename(resolvedSrc, '.jsonl');
    if (fileBasename !== claudeSessionId) {
      throw new MigrationError(
        'basename_mismatch',
        `migrateTranscript: basename UUID mismatch — file is ${fileBasename}, expected ${claudeSessionId}`
      );
    }
  }

  // Validate the raw targetConfigDir is not itself a symlink
  const rawTargetDir = resolve(targetConfigDir);
  const rawTargetStat = lstatSync(rawTargetDir, { throwIfNoEntry: false });
  if (rawTargetStat?.isSymbolicLink()) {
    throw new MigrationError('target_parent_symlink', `migrateTranscript: symlinked target parent component rejected: ${rawTargetDir}`);
  }

  const resolvedTargetDir = realpathSync(rawTargetDir);
  const targetPath = join(resolvedTargetDir, rel);

  // Validate no target path traversal
  if (!targetPath.startsWith(resolvedTargetDir + '/')) {
    throw new MigrationError('target_path_traversal', `migrateTranscript: target path traversal detected`);
  }

  mkdirSync(dirname(targetPath), { recursive: true, mode: 0o700 });

  validateTargetParentComponents(targetPath, resolvedTargetDir);

  const sourceSha256 = await sha256File(resolvedSrc);

  // Handle existing destination
  if (existsSync(targetPath)) {
    const destStat = lstatSync(targetPath);
    if (destStat.isSymbolicLink()) {
      throw new MigrationError('target_symlink', `migrateTranscript: symlink at target path rejected`);
    }
    if (!destStat.isFile()) {
      throw new MigrationError('target_non_regular', `migrateTranscript: non-regular file at target path`);
    }
    const destSha256 = await sha256File(targetPath);
    if (destSha256 === sourceSha256 && destStat.size === srcStat.size) {
      return { status: 'already_migrated', targetPath, sourceSha256, targetSha256: destSha256, sourceSize: srcStat.size };
    }
    // Collision — rename aside and recopy
    const bakPath = `${targetPath}.bak.${Date.now()}`;
    renameSync(targetPath, bakPath);
    const collisionCopy = await atomicCopy(resolvedSrc, targetPath);
    if (collisionCopy.bytesCopied !== srcStat.size) {
      throw new MigrationError('byte_count_mismatch', `migrateTranscript: byte count mismatch — expected ${srcStat.size}, got ${collisionCopy.bytesCopied}`);
    }
    const targetSha256 = await sha256File(targetPath);
    return { status: 'collision_renamed', targetPath, sourceSha256, targetSha256, sourceSize: srcStat.size };
  }

  const copyResult = await atomicCopy(resolvedSrc, targetPath);
  if (copyResult.bytesCopied !== srcStat.size) {
    throw new MigrationError('byte_count_mismatch', `migrateTranscript: byte count mismatch — expected ${srcStat.size}, got ${copyResult.bytesCopied}`);
  }
  const targetSha256 = await sha256File(targetPath);

  if (targetSha256 !== sourceSha256) {
    throw new MigrationError('integrity_check_failed', `migrateTranscript: integrity check failed — SHA-256 mismatch after copy`);
  }

  return { status: 'copied', targetPath, sourceSha256, targetSha256, sourceSize: srcStat.size };
}
