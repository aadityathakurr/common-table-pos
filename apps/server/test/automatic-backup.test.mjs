import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { existsSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runAutomaticBackup } from '../dist/automatic-backup.js';

const tenantId = 'tenant-backup-test';
const outletId = 'outlet-backup-test';

function seedDatabase(path, marker) {
  const database = new Database(path);
  database.pragma('foreign_keys = ON');
  database.exec(readFileSync(new URL('../src/schema.sql', import.meta.url), 'utf8'));
  database.prepare('INSERT OR IGNORE INTO tenants(id,name) VALUES(?,?)').run(tenantId, 'Backup test cafe');
  database.prepare('INSERT OR IGNORE INTO outlets(id,tenant_id,name) VALUES(?,?,?)').run(outletId, tenantId, 'Backup test outlet');
  database.exec('CREATE TABLE IF NOT EXISTS backup_test_marker(value TEXT NOT NULL)');
  database.prepare('DELETE FROM backup_test_marker').run();
  database.prepare('INSERT INTO backup_test_marker(value) VALUES(?)').run(marker);
  return database;
}

test('automatic backups create a verified private daily snapshot and prune only expired snapshots', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'common-table-auto-backup-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const databasePath = join(directory, 'outlet.sqlite');
  const backupDirectory = join(directory, 'backups');
  const database = seedDatabase(databasePath, 'lunch-service');
  t.after(() => database.close());
  const now = new Date('2026-10-25T10:00:00.000Z');
  const options = { database, databasePath, backupDirectory, tenantId, outletId, retentionDays: 7, now: () => now };

  await mkdir(backupDirectory, { recursive: true });
  const expiredBackup = join(backupDirectory, 'common-table-2026-10-01.db');
  const unrelatedFile = join(backupDirectory, 'notes.txt');
  writeFileSync(expiredBackup, 'expired');
  writeFileSync(unrelatedFile, 'keep');
  const old = new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000);
  utimesSync(expiredBackup, old, old);

  const result = await runAutomaticBackup(options);
  const dailyBackup = join(backupDirectory, 'common-table-2026-10-25.db');
  assert.equal(result.path, dailyBackup);
  assert.equal(result.skipped, false);
  assert.equal(result.removed, 1);
  if (process.platform !== 'win32') assert.equal(statSync(dailyBackup).mode & 0o777, 0o600);
  assert.equal(statSync(dailyBackup).isFile(), true);
  assert.equal(existsSync(expiredBackup), false);
  assert.equal(readFileSync(unrelatedFile, 'utf8'), 'keep');

  const verified = new Database(dailyBackup, { readonly: true, fileMustExist: true });
  assert.equal(verified.pragma('quick_check')[0].quick_check, 'ok');
  assert.equal(verified.prepare('SELECT value FROM backup_test_marker').get().value, 'lunch-service');
  verified.close();

  const repeated = await runAutomaticBackup(options);
  assert.equal(repeated.skipped, true);
  assert.equal(repeated.path, dailyBackup);
});

test('automatic backup replaces a corrupt same-day file and rejects invalid retention', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'common-table-auto-backup-corrupt-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const databasePath = join(directory, 'outlet.sqlite');
  const backupDirectory = join(directory, 'backups');
  const database = seedDatabase(databasePath, 'verified');
  t.after(() => database.close());
  const now = new Date('2026-10-25T10:00:00.000Z');
  const destination = join(backupDirectory, 'common-table-2026-10-25.db');
  await mkdir(backupDirectory, { recursive: true });
  writeFileSync(destination, 'corrupt');
  const options = { database, databasePath, backupDirectory, tenantId, outletId, now: () => now };

  const result = await runAutomaticBackup(options);
  assert.equal(result.skipped, false);
  const verified = new Database(destination, { readonly: true, fileMustExist: true });
  assert.equal(verified.pragma('quick_check')[0].quick_check, 'ok');
  verified.close();
  await assert.rejects(() => runAutomaticBackup({ ...options, retentionDays: 0 }), /RETENTION_DAYS/);
});
