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
  `
  -- 按月清零:每月 reset_day 号(1-28,0 = 不清零)把客户各线路的流量清零;last_reset_at 是上次清零的时间
  ALTER TABLE customers ADD COLUMN reset_day INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE customers ADD COLUMN last_reset_at INTEGER NOT NULL DEFAULT 0;

  -- 通知去重:某件事(如「客户 3 天内到期」)只提醒一次,记下提醒过的 key
  CREATE TABLE notified (
    key TEXT PRIMARY KEY,
    at  INTEGER NOT NULL
  );
  `,
  `
  -- 客户自己的 Clash 订阅模板:'' = 默认(ACL4SSR_Online_Mini),内置模板的 id,或自定义的 https 地址
  ALTER TABLE customers ADD COLUMN sub_template TEXT NOT NULL DEFAULT '';
  `,
  `
  -- 每条线路同时在线的 IP 数上限(写到面板客户端的 limitIp),0 = 不限
  ALTER TABLE customers ADD COLUMN limit_ip INTEGER NOT NULL DEFAULT 0;

  -- 开放 API 的令牌:只存 SHA-256,明文只在创建时给一次;hint 是明文的末 4 位,方便认是哪一个
  CREATE TABLE api_tokens (
    id           INTEGER PRIMARY KEY,
    name         TEXT NOT NULL,
    hash         TEXT NOT NULL UNIQUE,
    hint         TEXT NOT NULL,
    created_at   INTEGER NOT NULL,
    last_used_at INTEGER
  );
  `,
  `
  -- 设备数上限改在订阅链接上做(不再往面板写 limitIp):每个拉过订阅的客户端记一台,满了新设备拉不到。
  -- limit_ip 这一列从此不再使用(迁移只追加不改,列留着)
  ALTER TABLE customers ADD COLUMN limit_devices INTEGER NOT NULL DEFAULT 0;
  UPDATE customers SET limit_devices = limit_ip;
  CREATE TABLE sub_devices (
    id          INTEGER PRIMARY KEY,
    customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    key         TEXT NOT NULL,
    ua          TEXT NOT NULL,
    ip          TEXT NOT NULL,
    first_at    INTEGER NOT NULL,
    last_at     INTEGER NOT NULL,
    UNIQUE (customer_id, key)
  );
  `,
  `
  -- MCP 的 OAuth:动态注册的客户端;用户授权过的应用(每次授权一条,带当前的刷新令牌);访问令牌。令牌只存 SHA-256
  CREATE TABLE oauth_clients (
    client_id     TEXT PRIMARY KEY,
    client_name   TEXT NOT NULL,
    redirect_uris TEXT NOT NULL,
    created_at    INTEGER NOT NULL
  );
  CREATE TABLE oauth_grants (
    id                 INTEGER PRIMARY KEY,
    client_id          TEXT NOT NULL,
    client_name        TEXT NOT NULL,
    created_at         INTEGER NOT NULL,
    last_used_at       INTEGER,
    refresh_hash       TEXT,
    refresh_expires_at INTEGER
  );
  CREATE INDEX oauth_grants_refresh ON oauth_grants(refresh_hash);
  CREATE TABLE oauth_access (
    hash       TEXT PRIMARY KEY,
    grant_id   INTEGER NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  `,
  `
  -- 流量统计。traffic_seen:每个客户端上次同步时的累计流量(算增量的起点);
  -- traffic_daily:每个客户端每天用的流量,customer_id 是当时它归在哪位客户名下(没归入的为空)。
  -- 统计不跟着面板 / 客户删:删掉以后历史还在,只是名字显示成「已删除」
  CREATE TABLE traffic_seen (
    panel_id INTEGER NOT NULL REFERENCES panels(id) ON DELETE CASCADE,
    email    TEXT NOT NULL,
    up       INTEGER NOT NULL,
    down     INTEGER NOT NULL,
    PRIMARY KEY (panel_id, email)
  ) WITHOUT ROWID;
  CREATE TABLE traffic_daily (
    day         TEXT NOT NULL,
    panel_id    INTEGER NOT NULL,
    email       TEXT NOT NULL,
    customer_id INTEGER,
    up          INTEGER NOT NULL DEFAULT 0,
    down        INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, panel_id, email)
  ) WITHOUT ROWID;
  `,
  `
  -- 自定义订阅链接:客户另配的访问地址,访问它等于访问 /sub/<token>。
  -- link 是后台填的样子(显示用);path / query 是规范化后的(匹配用:路径小写、去末尾 /,参数排好序)
  CREATE TABLE sub_links (
    id          INTEGER PRIMARY KEY,
    customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    link        TEXT NOT NULL,
    path        TEXT NOT NULL,
    query       TEXT NOT NULL,
    UNIQUE (path, query)
  );
  CREATE INDEX sub_links_customer ON sub_links(customer_id);
  `,
  `
  -- 面板 / SOCKS 的月成本(NULL = 没填)和到期时间(毫秒,0 = 没填 / 不限期),只用来记账和提醒续费
  ALTER TABLE panels ADD COLUMN monthly_cost REAL;
  ALTER TABLE panels ADD COLUMN expire_at INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE socks_proxies ADD COLUMN monthly_cost REAL;
  ALTER TABLE socks_proxies ADD COLUMN expire_at INTEGER NOT NULL DEFAULT 0;
  `,
  `
  -- 线路的自定义节点名:订阅和分享链接里代替面板生成的名字,空 = 用面板的
  ALTER TABLE lines ADD COLUMN node_name TEXT NOT NULL DEFAULT '';
  `,
  `
  -- 外部订阅:客户拉订阅时把这些地址里的节点一起给出去(或只给这些,见 customers.upstream_mode)。
  -- links / nodes / skipped / userinfo / ok_at 是上次成功取到的结果,取不到时照常用;tried_at / error 是上次尝试
  CREATE TABLE upstream_subs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    -- 节点名:空 = 用对方的;可带 {name}(原名)/ {n}(序号),见 subscription/nodeName.ts 的 renameByTemplate
    node_name TEXT NOT NULL DEFAULT '',
    position INTEGER NOT NULL DEFAULT 0,
    links TEXT NOT NULL DEFAULT '[]',
    nodes INTEGER NOT NULL DEFAULT 0,
    skipped INTEGER NOT NULL DEFAULT 0,
    userinfo TEXT NOT NULL DEFAULT '',
    ok_at INTEGER NOT NULL DEFAULT 0,
    tried_at INTEGER NOT NULL DEFAULT 0,
    error TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX upstream_subs_customer ON upstream_subs(customer_id);
  -- merge = 外部订阅的节点和自己线路的一起给;replace = 只给外部订阅的
  ALTER TABLE customers ADD COLUMN upstream_mode TEXT NOT NULL DEFAULT 'merge';
  -- 1 = 订阅里的流量和到期(subscription-userinfo)用外部订阅给的
  ALTER TABLE customers ADD COLUMN upstream_userinfo INTEGER NOT NULL DEFAULT 0;
  `,
  `
  -- 线路实际的出口:同步时读面板的 Xray 路由算出来(JSON 数组,见 lines/routes.ts),NULL = 还没读到
  ALTER TABLE lines ADD COLUMN routes TEXT;
  ALTER TABLE lines ADD COLUMN routes_at INTEGER NOT NULL DEFAULT 0;
  `,
  `
  -- 线路的出口规则(在 xui-hub 里配、写到面板 Xray 路由):JSON 数组,见 lines/rules.ts
  ALTER TABLE lines ADD COLUMN rules TEXT NOT NULL DEFAULT '[]';
  `,
  `
  -- 客户的月费(每月收多少,NULL = 没填),只用来记账
  ALTER TABLE customers ADD COLUMN monthly_fee REAL;
  `,
  `
  -- 流量倍率:计费用量 = 实际流量 × 倍率(订阅里显示的已用、额度判断都按它),默认 1。实际流量和流量统计不变
  ALTER TABLE customers ADD COLUMN traffic_ratio REAL NOT NULL DEFAULT 1;
  -- 结转的流量:删掉的线路本期用掉的、面板上计数被清零前的、手动调整的,都记在客户身上,清零时一起清
  ALTER TABLE customers ADD COLUMN carried_up INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE customers ADD COLUMN carried_down INTEGER NOT NULL DEFAULT 0;
  -- 线路上次在 xui-hub 里清零的时间:清零前读到的面板计数不再写回(不然会被当成面板上清零了而结转)
  ALTER TABLE lines ADD COLUMN zeroed_at INTEGER NOT NULL DEFAULT 0;
  `,
  `
  -- 面板连续检查失败的次数和第一次失败的时间(成功一次就清零):连续失败够设置里的次数才发「连不上」
  ALTER TABLE panels ADD COLUMN check_fail_count INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE panels ADD COLUMN check_fail_since INTEGER;
  -- 升级时已经连不上的面板:旧版本一失败就发了「连不上」,这里记成发过,恢复时照常发「恢复正常」
  UPDATE panels SET check_fail_count = 1, check_fail_since = COALESCE(check_ok_at, checked_at) WHERE check_error IS NOT NULL;
  INSERT OR IGNORE INTO notified (key, at) SELECT 'panel_down:' || id, COALESCE(check_ok_at, checked_at, 0) FROM panels WHERE check_error IS NOT NULL;
  `,
  `
  -- 面板地址解析出的 IP(地址本身就是 IP 时也记),检查时更新;解析不出来保留上次的
  ALTER TABLE panels ADD COLUMN ip TEXT;
  `,
  `
  -- 续费 / 收款记录:续费时记一笔(没填金额的 amount 为 NULL = 只续期),也可以单独记收款(months / days 都是 0)。
  -- 客户删了记录还在,customer_name 是记的时候的名字;expire_before / expire_after 是这笔前后的到期时间
  CREATE TABLE payments (
    id            INTEGER PRIMARY KEY,
    customer_id   INTEGER NOT NULL,
    customer_name TEXT NOT NULL,
    amount        REAL,
    paid_at       INTEGER NOT NULL,
    months        INTEGER NOT NULL DEFAULT 0,
    days          INTEGER NOT NULL DEFAULT 0,
    expire_before INTEGER NOT NULL DEFAULT 0,
    expire_after  INTEGER NOT NULL DEFAULT 0,
    note          TEXT NOT NULL DEFAULT '',
    created_at    INTEGER NOT NULL
  );
  CREATE INDEX payments_customer ON payments(customer_id, paid_at);
  CREATE INDEX payments_paid ON payments(paid_at);
  `,
  `
  -- 操作日志:后台、API 令牌、MCP 每次改东西记一条。actor = 谁(后台 / 令牌「名字」/ MCP · 客户端),
  -- action = 方法 + 路由(如 POST /customers/:id/renew),summary = 给人看的一句话;customer_id 是涉及的客户(没有为空)
  CREATE TABLE op_log (
    id          INTEGER PRIMARY KEY,
    at          INTEGER NOT NULL,
    actor       TEXT NOT NULL,
    ip          TEXT NOT NULL DEFAULT '',
    action      TEXT NOT NULL,
    summary     TEXT NOT NULL,
    ok          INTEGER NOT NULL,
    error       TEXT NOT NULL DEFAULT '',
    customer_id INTEGER
  );
  CREATE INDEX op_log_at ON op_log(at);
  CREATE INDEX op_log_customer ON op_log(customer_id, id);
  `,
  `
  -- 客户 / 面板的 id 不再复用:记下用过的最大 id(含已经删掉、只剩收款 / 流量 / 日志 / 拉取记录的),新建时从它往上数(见 nextId)
  INSERT OR REPLACE INTO meta (key, value) SELECT 'customers_max_id', CAST(COALESCE(MAX(m), 0) AS TEXT) FROM (
    SELECT MAX(id) AS m FROM customers
    UNION ALL SELECT MAX(customer_id) FROM payments
    UNION ALL SELECT MAX(customer_id) FROM traffic_daily
    UNION ALL SELECT MAX(customer_id) FROM op_log
    UNION ALL SELECT MAX(customer_id) FROM sub_fetches
  );
  INSERT OR REPLACE INTO meta (key, value) SELECT 'panels_max_id', CAST(COALESCE(MAX(m), 0) AS TEXT) FROM (
    SELECT MAX(id) AS m FROM panels
    UNION ALL SELECT MAX(panel_id) FROM traffic_daily
  );
  `,
  `
  -- 面板的节点名:这块面板上没单独设节点名的线路,订阅里用它;空 = 用面板(3x-ui)生成的名字
  ALTER TABLE panels ADD COLUMN node_name TEXT NOT NULL DEFAULT '';
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

/**
 * 新客户 / 新面板的 id:比现在的和以前用过的都大。SQLite 不带 AUTOINCREMENT 的表会复用删掉的最大 id,
 * 而收款、流量统计、操作日志、拉取记录按 id 留着删掉的客户 / 面板的记录,复用了就会串到新的头上
 */
export function nextId(db: DB, table: 'customers' | 'panels'): number {
  const key = `${table}_max_id`;
  const max = Math.max(Number(getMeta(db, key)) || 0, (db.prepare(`SELECT COALESCE(MAX(id), 0) AS m FROM ${table}`).get() as { m: number }).m);
  setMeta(db, key, String(max + 1));
  return max + 1;
}
