import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { MIGRATIONS, getMeta, openDb, setMeta } from './db';

/** 一个测完就删的临时库文件(放在还不存在的子目录里) */
function tempFile(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'xuihub-db-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'data', 'hub.db');
}

const version = (db: Database.Database) => db.pragma('user_version', { simple: true });

test('新库:目录自己建(只有自己能进),迁移跑到最新,外键开着;再打开不重复迁移,数据还在', (t) => {
  const file = tempFile(t);
  let db = openDb(file);
  assert.equal(statSync(dirname(file)).mode & 0o777, 0o700);
  assert.equal(version(db), MIGRATIONS.length);
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
  assert.equal(db.pragma('journal_mode', { simple: true }), 'wal');
  setMeta(db, 'k', 'v');
  db.close();

  db = openDb(file);
  assert.equal(version(db), MIGRATIONS.length);
  assert.equal(getMeta(db, 'k'), 'v');
  db.close();
});

test('从没有订阅的旧版本升级:只补跑后面的迁移,老客户各补一个不重复的订阅 token,原有数据不动', (t) => {
  const file = tempFile(t);
  mkdirSync(dirname(file), { recursive: true });
  const before = MIGRATIONS.findIndex((m) => m.includes('ADD COLUMN sub_token'));
  assert.ok(before > 0);
  const old = new Database(file);
  for (const sql of MIGRATIONS.slice(0, before)) old.exec(sql);
  old.pragma(`user_version = ${before}`);
  const add = old.prepare('INSERT INTO customers (name, remark, quota_bytes, expire_at, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 1)');
  add.run('张三', '老客户', 1000, 0);
  add.run('李四', '', 0, 99);
  old.close();

  const db = openDb(file);
  assert.equal(version(db), MIGRATIONS.length);
  const rows = db.prepare('SELECT name, remark, quota_bytes, expire_at, sub_token FROM customers ORDER BY id').all() as any[];
  assert.deepEqual(rows.map((r) => [r.name, r.remark, r.quota_bytes, r.expire_at]), [['张三', '老客户', 1000, 0], ['李四', '', 0, 99]]);
  assert.ok(rows.every((r) => /^[0-9a-f]{36}$/.test(r.sub_token)));
  assert.notEqual(rows[0].sub_token, rows[1].sub_token);
  // token 不许重复
  assert.throws(() => db.prepare('INSERT INTO customers (name, sub_token, created_at, updated_at) VALUES (?, ?, 1, 1)').run('王五', rows[0].sub_token), /UNIQUE/);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM sub_fetches').get() as { n: number }).n, 0);
  db.close();
});

test('升级到「连续失败才算掉线」:已经连不上的面板记成发过「连不上」,恢复时照常发「恢复」;好的面板不动', (t) => {
  const file = tempFile(t);
  mkdirSync(dirname(file), { recursive: true });
  const before = MIGRATIONS.findIndex((m) => m.includes('ADD COLUMN check_fail_count'));
  assert.ok(before > 0);
  const old = new Database(file);
  for (const sql of MIGRATIONS.slice(0, before)) old.exec(sql);
  old.pragma(`user_version = ${before}`);
  const add = old.prepare('INSERT INTO panels (name, base_url, token, created_at, checked_at, check_ok_at, check_error) VALUES (?, ?, ?, 1, ?, ?, ?)');
  add.run('up', 'https://up.example', 't', 500, 500, null);
  add.run('down', 'https://down.example', 't', 900, 300, '连接超时');
  add.run('never', 'https://never.example', 't', 900, null, '连接超时');
  old.close();

  const db = openDb(file);
  assert.equal(version(db), MIGRATIONS.length);
  const rows = db.prepare('SELECT name, check_fail_count, check_fail_since FROM panels ORDER BY id').all() as any[];
  assert.deepEqual(rows.map((r) => [r.name, r.check_fail_count, r.check_fail_since]), [['up', 0, null], ['down', 1, 300], ['never', 1, 900]]);
  assert.deepEqual(db.prepare('SELECT key, at FROM notified ORDER BY key').all(), [{ key: 'panel_down:2', at: 300 }, { key: 'panel_down:3', at: 900 }]);
  db.close();
});

test('meta:没存过返回 undefined,重复写是覆盖', () => {
  const db = openDb(':memory:');
  assert.equal(getMeta(db, 'k'), undefined);
  setMeta(db, 'k', 'a');
  setMeta(db, 'k', 'b');
  assert.equal(getMeta(db, 'k'), 'b');
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM meta').get() as { n: number }).n, 1);
});
