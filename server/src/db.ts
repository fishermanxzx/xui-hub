// SQLite 存储与迁移。迁移按 user_version 顺序执行,只追加不修改。

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type DB = Database.Database;

/** 导出是给测试用的(从旧版本的库升级) */
export const MIGRATIONS: string[] = [
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
  `
  -- SOCKS 代理(中转的出口);账号密码只在服务端,接口不返回密码。check_* 是最近一次连通性测试
  CREATE TABLE socks_proxies (
    id          INTEGER PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE,
    host        TEXT NOT NULL,
    port        INTEGER NOT NULL,
    username    TEXT NOT NULL DEFAULT '',
    password    TEXT NOT NULL DEFAULT '',
    remark      TEXT NOT NULL DEFAULT '',
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    check_at    INTEGER,
    check_ok    INTEGER,
    check_ms    INTEGER,
    check_ip    TEXT,
    check_loc   TEXT,
    check_error TEXT
  );
  `,
  `
  -- 客户:名字 + 备注,线路挂在下面
  CREATE TABLE customers (
    id         INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    remark     TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  -- 线路 = 客户在某块面板上的一个 client。kind:direct 客户端直连这块面板;relay 这块面板是中转,流量转到出口。
  -- 出口(只有 relay 有):exit_kind panel = 落地面板(exit_panel_id,经它上面的 socks 入站 exit_port),socks = SOCKS 页登记的(exit_socks_id)
  CREATE TABLE lines (
    id             INTEGER PRIMARY KEY,
    customer_id    INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    kind           TEXT NOT NULL CHECK (kind IN ('direct', 'relay')),
    panel_id       INTEGER NOT NULL REFERENCES panels(id) ON DELETE CASCADE,
    inbound_id     INTEGER NOT NULL,
    inbound_remark TEXT NOT NULL DEFAULT '',
    protocol       TEXT NOT NULL DEFAULT '',
    email          TEXT NOT NULL,
    exit_kind      TEXT CHECK (exit_kind IN ('panel', 'socks')),
    exit_panel_id  INTEGER REFERENCES panels(id) ON DELETE SET NULL,
    exit_port      INTEGER,
    exit_socks_id  INTEGER REFERENCES socks_proxies(id) ON DELETE SET NULL,
    exit_label     TEXT NOT NULL DEFAULT '',
    created_at     INTEGER NOT NULL,
    UNIQUE (panel_id, email)
  );
  CREATE INDEX lines_customer ON lines(customer_id);
  `,
  `
  -- 客户的总额度(字节,0 = 不限)和到期时间(毫秒,0 = 不限期);线路记下同步到的客户端流量和启用状态
  ALTER TABLE customers ADD COLUMN quota_bytes INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE customers ADD COLUMN expire_at INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE lines ADD COLUMN up INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE lines ADD COLUMN down INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE lines ADD COLUMN enable INTEGER NOT NULL DEFAULT 1;
  -- 是本系统因超额 / 到期停用的(恢复正常时才会自动重新启用,面板上手动停的不管)
  ALTER TABLE lines ADD COLUMN auto_disabled INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE lines ADD COLUMN last_online INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE lines ADD COLUMN synced_at INTEGER;
  `,
  `
  -- 订阅:每个客户一个 token(/sub/<token>),记上次拉取的时间和客户端
  ALTER TABLE customers ADD COLUMN sub_token TEXT;
  ALTER TABLE customers ADD COLUMN sub_fetched_at INTEGER;
  ALTER TABLE customers ADD COLUMN sub_fetched_ua TEXT;
  UPDATE customers SET sub_token = lower(hex(randomblob(18))) WHERE sub_token IS NULL;
  CREATE UNIQUE INDEX customers_sub_token ON customers(sub_token);

  -- 订阅拉取记录(保留 SUB_LOG_DAYS 天):哪个客户、客户端 UA、来源 IP、给的格式、结果
  CREATE TABLE sub_fetches (
    id          INTEGER PRIMARY KEY,
    at          INTEGER NOT NULL,
    customer_id INTEGER NOT NULL,
    target      TEXT NOT NULL,
    status      INTEGER NOT NULL,
    ua          TEXT NOT NULL,
    ip          TEXT NOT NULL
  );
  CREATE INDEX sub_fetches_customer ON sub_fetches(customer_id, at);
  CREATE INDEX sub_fetches_at ON sub_fetches(at);
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
