import { dirname, join, resolve } from 'node:path';
import { createVerifiedBackup } from './database-backup.js';
import { DATABASE_PATH, db } from './database.js';
import { EDGE_CONFIG } from './config.js';

const backupDirectory = resolve(process.env.POS_BACKUP_DIR?.trim() || join(dirname(DATABASE_PATH), 'backups'));
const destination = resolve(process.env.POS_BACKUP_PATH ?? join(backupDirectory, `common-table-${new Date().toISOString().replaceAll(':', '-')}.db`));

try {
  await createVerifiedBackup(db, DATABASE_PATH, destination, { tenantId: EDGE_CONFIG.tenantId, outletId: EDGE_CONFIG.outletId });
  console.log(JSON.stringify({ level: 'info', event: 'database.backup.completed', destination, integrity: 'ok',
    tenantId: EDGE_CONFIG.tenantId, outletId: EDGE_CONFIG.outletId }));
} catch (error) {
  console.error(JSON.stringify({ level: 'error', event: 'database.backup.failed', message: error instanceof Error ? error.message : 'unknown' }));
  process.exitCode = 1;
} finally {
  db.close();
}
