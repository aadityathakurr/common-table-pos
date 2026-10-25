import Database from 'better-sqlite3';
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';

export type BackupIdentity = { tenantId: string; outletId: string };

export function verifyBackupFile(path: string, identity: BackupIdentity): void {
  const backup = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const integrity = backup.pragma('quick_check') as Array<{ quick_check: string }>;
    if (integrity.length !== 1 || integrity[0]?.quick_check !== 'ok') {
      throw new Error('Backup verification failed: staged copy failed SQLite quick_check.');
    }
    const foreignKeys = backup.pragma('foreign_key_check') as Array<Record<string, unknown>>;
    if (foreignKeys.length) throw new Error(`Backup verification failed: staged copy has ${foreignKeys.length} foreign-key violation(s).`);
    const tenant = backup.prepare('SELECT 1 FROM tenants WHERE id=?').get(identity.tenantId);
    const outlet = backup.prepare('SELECT 1 FROM outlets WHERE id=? AND tenant_id=?').get(identity.outletId, identity.tenantId);
    if (!tenant || !outlet) throw new Error('Backup verification failed: staged copy does not contain the configured tenant and outlet.');
  } finally {
    backup.close();
  }
}

export async function createVerifiedBackup(
  source: Database.Database,
  sourcePath: string,
  destinationPath: string,
  identity: BackupIdentity,
): Promise<void> {
  const sourceFile = resolve(sourcePath);
  const destination = resolve(destinationPath);
  if (sourceFile === destination) throw new Error('The backup destination must be different from the outlet database.');

  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') chmodSync(dirname(destination), 0o700);
  const staged = resolve(dirname(destination), `.${basename(destination)}.backup-${process.pid}-${Date.now()}.tmp`);
  const previous = `${destination}.previous-${process.pid}-${Date.now()}`;
  let previousMoved = false;
  try {
    await source.backup(staged);
    chmodSync(staged, 0o600);
    verifyBackupFile(staged, identity);
    if (existsSync(destination)) {
      renameSync(destination, previous);
      previousMoved = true;
    }
    try {
      renameSync(staged, destination);
    } catch (error) {
      if (previousMoved && !existsSync(destination)) renameSync(previous, destination);
      throw error;
    }
    if (previousMoved) rmSync(previous, { force: true });
  } finally {
    if (existsSync(staged)) rmSync(staged, { force: true });
    if (previousMoved && existsSync(previous) && existsSync(destination)) rmSync(previous, { force: true });
  }
}
