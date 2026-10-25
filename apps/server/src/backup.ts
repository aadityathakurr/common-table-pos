import Database from 'better-sqlite3';
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { db } from './database.js';
import { EDGE_CONFIG } from './config.js';

const destination = resolve(process.env.POS_BACKUP_PATH ?? `.data/backups/common-table-${new Date().toISOString().replaceAll(':', '-')}.db`);
mkdirSync(dirname(destination), { recursive: true });
const stagedBackup = resolve(dirname(destination), `.${basename(destination)}.backup-${process.pid}-${Date.now()}.tmp`);
let verifiedBackup: Database.Database | undefined;

try {
  await db.backup(stagedBackup);
  verifiedBackup = new Database(stagedBackup, { readonly: true, fileMustExist: true });
  const integrity = verifiedBackup.pragma('quick_check') as Array<{ quick_check: string }>;
  if (integrity.length !== 1 || integrity[0]?.quick_check !== 'ok') throw new Error('Backup verification failed: staged copy failed SQLite quick_check.');
  const foreignKeys = verifiedBackup.pragma('foreign_key_check') as Array<Record<string, unknown>>;
  if (foreignKeys.length) throw new Error(`Backup verification failed: staged copy has ${foreignKeys.length} foreign-key violation(s).`);
  const tenant = verifiedBackup.prepare('SELECT 1 FROM tenants WHERE id=?').get(EDGE_CONFIG.tenantId);
  const outlet = verifiedBackup.prepare('SELECT 1 FROM outlets WHERE id=? AND tenant_id=?').get(EDGE_CONFIG.outletId, EDGE_CONFIG.tenantId);
  if (!tenant || !outlet) throw new Error('Backup verification failed: staged copy does not contain the configured tenant and outlet.');
  verifiedBackup.close(); verifiedBackup = undefined;
  renameSync(stagedBackup, destination);
  console.log(JSON.stringify({ level: 'info', event: 'database.backup.completed', destination, integrity: 'ok',
    tenantId: EDGE_CONFIG.tenantId, outletId: EDGE_CONFIG.outletId }));
} catch (error) {
  console.error(JSON.stringify({ level: 'error', event: 'database.backup.failed', message: error instanceof Error ? error.message : 'unknown' }));
  process.exitCode = 1;
} finally {
  verifiedBackup?.close();
  if (existsSync(stagedBackup)) rmSync(stagedBackup, { force: true });
  db.close();
}
