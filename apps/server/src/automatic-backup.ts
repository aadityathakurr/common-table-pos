import Database from 'better-sqlite3';
import { existsSync, lstatSync, readdirSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createVerifiedBackup, verifyBackupFile, type BackupIdentity } from './database-backup.js';

const dayMs = 24 * 60 * 60 * 1000;
const backupCheckIntervalMs = 60 * 60 * 1000;
const backupFilenamePattern = /^common-table-\d{4}-\d{2}-\d{2}\.db$/;

export type AutomaticBackupOptions = BackupIdentity & {
  database: Database.Database;
  databasePath: string;
  backupDirectory?: string;
  retentionDays?: number;
  now?: () => Date;
};

export async function runAutomaticBackup(options: AutomaticBackupOptions): Promise<{ path: string; skipped: boolean; removed: number }> {
  const now = options.now?.() ?? new Date();
  const directory = resolve(options.backupDirectory ?? join(dirname(options.databasePath), 'backups'));
  const destination = join(directory, `common-table-${now.toISOString().slice(0, 10)}.db`);
  const retentionDays = options.retentionDays ?? 7;
  if (!Number.isSafeInteger(retentionDays) || retentionDays < 1 || retentionDays > 365) {
    throw new Error('POS_AUTO_BACKUP_RETENTION_DAYS must be an integer from 1 to 365.');
  }

  let skipped = false;
  if (existsSync(destination)) {
    try {
      verifyBackupFile(destination, options);
      skipped = true;
    } catch {
      await createVerifiedBackup(options.database, options.databasePath, destination, options);
    }
  } else {
    await createVerifiedBackup(options.database, options.databasePath, destination, options);
  }

  const cutoffDate = new Date(now.getTime() - retentionDays * dayMs).toISOString().slice(0, 10);
  let removed = 0;
  for (const name of readdirSync(directory)) {
    if (!backupFilenamePattern.test(name)) continue;
    const backupDate = name.slice('common-table-'.length, -'.db'.length);
    if (backupDate >= cutoffDate) continue;
    const path = join(directory, name);
    const stat = lstatSync(path);
    if (stat.isFile()) {
      unlinkSync(path);
      removed += 1;
    }
  }
  return { path: destination, skipped, removed };
}

export function startAutomaticBackups(options: AutomaticBackupOptions): () => Promise<void> {
  let stopped = false;
  let inFlight: Promise<void> | undefined;
  const run = () => {
    if (stopped || inFlight) return;
    inFlight = runAutomaticBackup(options)
      .then(result => console.info(JSON.stringify({ level: 'info', event: result.skipped ? 'database.backup.already_current' : 'database.backup.completed', destination: result.path, integrity: 'ok', removedOldBackups: result.removed })))
      .catch(error => console.error(JSON.stringify({ level: 'error', event: 'database.backup.failed', message: error instanceof Error ? error.message : 'unknown' })))
      .finally(() => { inFlight = undefined; });
  };

  run();
  const timer = setInterval(run, backupCheckIntervalMs);
  timer.unref();
  return async () => {
    stopped = true;
    clearInterval(timer);
    await inFlight;
  };
}
