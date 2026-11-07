// SQLite 存储与迁移。迁移按 user_version 顺序执行,只追加不修改。

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type DB = Database.Database;

const MIGRATIONS: string[] = [
  `
  CREATE TABLE meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- 接入的 3x-ui 面板。check_* 是最近一次连通性检查的结果
  CREATE TABLE panels (
    id            INTEGER PRIMARY KEY,
    name          TEXT NOT NULL UNIQUE,
    base_url      TEXT NOT NULL,
    token         TEXT NOT NULL,
    created_at    INTEGER NOT NULL,
    checked_at    INTEGER,
    check_ok_at   INTEGER,
    check_error   TEXT,
    inbound_count INTEGER,
    client_count  INTEGER
  );
  `,
  `
  -- 检查时顺带记下面板版本、Xray 内核版本和运行状态
  ALTER TABLE panels ADD COLUMN panel_version TEXT;
  ALTER TABLE panels ADD COLUMN xray_version TEXT;
  ALTER TABLE panels ADD COLUMN xray_state TEXT;
  `,
];

export function openDb(file: string): DB {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}

function migrate(db: DB): void {
  const version = db.pragma('user_version', { simple: true }) as number;
  for (let i = version; i < MIGRATIONS.length; i++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[i]);
      db.pragma(`user_version = ${i + 1}`);
    })();
  }
}

export function getMeta(db: DB, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value;
}

export function setMeta(db: DB, key: string, value: string): void {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}
