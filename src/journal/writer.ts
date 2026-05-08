import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { JournalEvent, JournalWriter } from './types.js';

const SECRET_KEY_PATTERN = /^(.*_)?(token|secret|apikey|api_key|authorization|password|bot_token|app_token|signing_secret)$/i;

function scanForSecrets(obj: unknown, path = 'details'): void {
  if (!obj || typeof obj !== 'object') return;
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      scanForSecrets(obj[i], `${path}[${i}]`);
    }
    return;
  }
  for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
    if (SECRET_KEY_PATTERN.test(key)) {
      throw new Error(
        `Journal write rejected: forbidden secret key "${key}" found at ${path}.${key}`
      );
    }
    if (val && typeof val === 'object') {
      scanForSecrets(val, `${path}.${key}`);
    }
  }
}

export async function appendEvent(journalPath: string, event: JournalEvent): Promise<void> {
  scanForSecrets(event.details);

  const dir = dirname(journalPath);
  await mkdir(dir, { recursive: true, mode: 0o700 });

  const line = JSON.stringify(event) + '\n';

  try {
    await appendFile(journalPath, line, { encoding: 'utf8', mode: 0o600 });
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOSPC') {
      process.stderr.write(`[aisup] journal write failed: disk full (${journalPath})\n`);
      return;
    }
    throw err;
  }
}

export function createJournalWriter(journalPath: string): JournalWriter {
  return {
    append: (event: JournalEvent) => appendEvent(journalPath, event),
  };
}
