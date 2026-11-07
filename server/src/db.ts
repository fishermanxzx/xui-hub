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

  -- 面板 = 执行节点。role: relay 中转 / exit 落地;expire_at 是机器到期时间:NULL = 未填,0 = 不限期
  CREATE TABLE panels (
    id              INTEGER PRIMARY KEY,
    name            TEXT NOT NULL UNIQUE,
    base_url        TEXT NOT NULL,
    token           TEXT NOT NULL,
    ip              TEXT,
    provider        TEXT,
    role            TEXT NOT NULL DEFAULT 'exit' CHECK (role IN ('relay', 'exit')),
    monthly_cost    REAL,
    enabled         INTEGER NOT NULL DEFAULT 1,
    created_at      INTEGER NOT NULL,
    last_sync_at    INTEGER,
    last_sync_ok_at INTEGER,
    last_sync_error TEXT,
    client_count    INTEGER,
    expire_at       INTEGER
  );

  -- 删掉的面板留下名字和类型:历史流量里还看得出是哪台、按什么类型统计;新面板的 id 也不再复用它们的
  CREATE TABLE deleted_panels (
    id         INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    deleted_at INTEGER NOT NULL,
    role       TEXT CHECK (role IN ('relay', 'exit'))
  );

  -- 每个 (面板, email) 上次读到的累计计数器及客户端快照。不记凭据(uuid / 密码)、订阅 ID、所属入站等从没被读过的字段
  CREATE TABLE client_counters (
    panel_id       INTEGER NOT NULL REFERENCES panels(id) ON DELETE CASCADE,
    email          TEXT NOT NULL,
    up             INTEGER NOT NULL,
    down           INTEGER NOT NULL,
    comment        TEXT,
    enable         INTEGER NOT NULL DEFAULT 1,
    total_bytes    INTEGER NOT NULL DEFAULT 0,
    expiry_ms      INTEGER NOT NULL DEFAULT 0,
    last_online    INTEGER NOT NULL DEFAULT 0,
    updated_at     INTEGER NOT NULL,
    missing_since  INTEGER,
    PRIMARY KEY (panel_id, email)
  );

  -- 客户:全局额度 / 到期 / 已用。quota_bytes、expire_at 为 0 表示不限。
  -- sub_token:订阅链接 /sub/<token> 里的 token,每个客户一个,重置后旧链接失效。
  -- monthly_reset_at:每月按到期日自动重置流量的开启时间,0 = 关闭(开启前已过的重置日不补)。
  -- sub_fetched_at / sub_fetched_ua:上次拉取订阅的时间和客户端(User-Agent)
  CREATE TABLE customers (
    id               INTEGER PRIMARY KEY,
    name             TEXT NOT NULL,
    remark           TEXT NOT NULL DEFAULT '',
    monthly_price    REAL,
    quota_bytes      INTEGER NOT NULL DEFAULT 0,
    expire_at        INTEGER NOT NULL DEFAULT 0,
    status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
    used_up          INTEGER NOT NULL DEFAULT 0,
    used_down        INTEGER NOT NULL DEFAULT 0,
    usage_reset_at   INTEGER NOT NULL,
    sub_token        TEXT NOT NULL UNIQUE,
    monthly_reset_at INTEGER NOT NULL DEFAULT 0,
    sub_fetched_at   INTEGER,
    sub_fetched_ua   TEXT,
    created_at       INTEGER NOT NULL,
    updated_at       INTEGER NOT NULL
  );

  -- 线路绑定:一个面板上的一个 client 最多属于一个客户
  CREATE TABLE bindings (
    id          INTEGER PRIMARY KEY,
    customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    panel_id    INTEGER NOT NULL REFERENCES panels(id),
    email       TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    UNIQUE (panel_id, email)
  );
  CREATE INDEX bindings_customer ON bindings(customer_id);

  -- 流量账本:按小时累计增量。customer_id = 0 表示写入时未绑定客户;
  -- relay 记下当时这台面板是不是中转:面板改类型后,以前的流量仍按当时的类型统计
  CREATE TABLE traffic_hourly (
    hour        INTEGER NOT NULL,
    panel_id    INTEGER NOT NULL,
    email       TEXT NOT NULL,
    customer_id INTEGER NOT NULL DEFAULT 0,
    up          INTEGER NOT NULL DEFAULT 0,
    down        INTEGER NOT NULL DEFAULT 0,
    relay       INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (hour, panel_id, email, customer_id)
  );
  CREATE INDEX traffic_hourly_customer ON traffic_hourly(customer_id, hour);

  -- 计数器回退(面板重置流量、重装、client 重建)的审计记录
  CREATE TABLE counter_resets (
    id        INTEGER PRIMARY KEY,
    panel_id  INTEGER NOT NULL,
    email     TEXT NOT NULL,
    at        INTEGER NOT NULL,
    prev_up   INTEGER NOT NULL,
    prev_down INTEGER NOT NULL,
    cur_up    INTEGER NOT NULL,
    cur_down  INTEGER NOT NULL
  );

  -- 购买的 SOCKS 代理(中转/落地的出口);账号密码只在服务端,接口不返回密码。check_* 是最近一次连通性测试
  CREATE TABLE socks_proxies (
    id           INTEGER PRIMARY KEY,
    name         TEXT NOT NULL UNIQUE,
    host         TEXT NOT NULL,
    port         INTEGER NOT NULL,
    username     TEXT NOT NULL DEFAULT '',
    password     TEXT NOT NULL DEFAULT '',
    monthly_cost REAL,
    remark       TEXT NOT NULL DEFAULT '',
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL,
    check_at     INTEGER,
    check_ok     INTEGER,
    check_ms     INTEGER,
    check_ip     TEXT,
    check_loc    TEXT,
    check_error  TEXT
  );

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

  -- 面板配置快照:入站、client(含凭据)、Xray 模板,JSON 经 gzip 存放;有变化才存一份
  CREATE TABLE panel_snapshots (
    id       INTEGER PRIMARY KEY,
    panel_id INTEGER NOT NULL REFERENCES panels(id) ON DELETE CASCADE,
    taken_at INTEGER NOT NULL,
    hash     TEXT NOT NULL,
    inbounds INTEGER NOT NULL,
    clients  INTEGER NOT NULL,
    data     BLOB NOT NULL
  );
  CREATE INDEX panel_snapshots_panel ON panel_snapshots(panel_id, taken_at);
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
