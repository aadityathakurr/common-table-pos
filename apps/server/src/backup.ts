import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { db } from './database.js';

const destination = resolve(process.env.POS_BACKUP_PATH ?? `.data/backups/common-table-${new Date().toISOString().replaceAll(':', '-')}.db`);
mkdirSync(dirname(destination), { recursive: true });

try {
  await db.backup(destination);
  const result = db.prepare('PRAGMA quick_check').get() as { quick_check?: string };
  if (result.quick_check !== 'ok') throw new Error('Backup verification failed: SQLite quick_check did not return ok.');
  console.log(JSON.stringify({ level: 'info', event: 'database.backup.completed', destination, integrity: result.quick_check }));
} catch (error) {
  console.error(JSON.stringify({ level: 'error', event: 'database.backup.failed', message: error instanceof Error ? error.message : 'unknown' }));
  process.exitCode = 1;
} finally {
  db.close();
}
