import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyPendingRestore, backupBuffer, backupName, inspectBackup, stageRestore } from './backup';
import { createCustomer } from './customers/repo';
import { MIGRATIONS, openDb } from './db';
import { addPanel, memoryDb } from './testUtil';

test('备份是完整可用的库;核对时认得出不是 SQLite、不是 xui-hub 的库、版本太新', async () => {
  const db = memoryDb();
  addPanel(db, 'a');
  createCustomer(db, { name: 'c1' });
  const data = await backupBuffer(db);
  assert.deepEqual(inspectBackup(data), { version: MIGRATIONS.length, panels: 1, customers: 1, lines: 0 });
  assert.throws(() => inspectBackup(Buffer.from('hello')), /不是 SQLite/);

  const dir = mkdtempSync(join(tmpdir(), 'xh-'));
  try {
    const other = new Database(join(dir, 'o.db'));
    other.exec('CREATE TABLE t (x)');
    other.close();
    assert.throws(() => inspectBackup(readFileSync(join(dir, 'o.db'))), /没有 panels 表/);
    const newer = openDb(join(dir, 'n.db'));
    newer.pragma(`user_version = ${MIGRATIONS.length + 1}`);
    newer.close();
    assert.throws(() => inspectBackup(readFileSync(join(dir, 'n.db'))), /更新的版本/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('恢复:放好的文件在启动时换成 hub.db,旧库留 .bak;没有待恢复文件就什么都不做', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'xh-'));
  try {
    assert.equal(applyPendingRestore(dir), false);
    const live = openDb(join(dir, 'hub.db'));
    createCustomer(live, { name: 'old' });
    const src = memoryDb();
    createCustomer(src, { name: 'from-backup' });
    stageRestore(dir, await backupBuffer(src));
    live.close();
    writeFileSync(join(dir, 'hub.db-wal'), '');
    assert.equal(applyPendingRestore(dir, 0), true);
    assert.ok(!existsSync(join(dir, 'hub.db.restore')));
    assert.ok(!existsSync(join(dir, 'hub.db-wal')));
    assert.ok(readdirSync(dir).some((f) => f.startsWith('hub.db.bak-')));
    const after = openDb(join(dir, 'hub.db'));
    assert.deepEqual(after.prepare('SELECT name FROM customers').all(), [{ name: 'from-backup' }]);
    after.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.match(backupName(Date.UTC(2026, 0, 2, 3, 4) + new Date(Date.UTC(2026, 0, 2, 3, 4)).getTimezoneOffset() * 60000), /^xui-hub-20260102-0304\.db$/);
});
