// 流量统计:按天记每个客户端用了多少流量,「流量」页按客户、按面板两种视图汇总。
// 面板给的是累计值,这里每次同步算和上一次的差,记到当天(服务器所在时区)。面板上的客户端都记,不只是归到客户名下的:
// 按面板看是这块面板的全部流量,按客户看时没归入客户的单独算一行。
// 第一次见到的客户端只记下起点、不算流量(不然接入面板当天会把它历史上用的全算进来)。

import type { DB } from '../db';

/** 统计保留的天数 */
export const TRAFFIC_KEEP_DAYS = 365;
const DAY_MS = 86_400_000;

export function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 累计值比上次小说明面板上清零过(或删了重建),这时新值就是这段时间用的 */
const grown = (now: number, before: number) => (now >= before ? now - before : now);

/**
 * 一块面板同步完后调:clients 是面板上全部客户端当前的累计流量。
 * hasTraffic 为 false 的(面板这次没给它的流量记录)跳过,起点留着,下次有了再接着算
 */
export function recordTraffic(db: DB, panelId: number, clients: { email: string; up: number; down: number; hasTraffic?: boolean }[], now = Date.now()): void {
  const day = dayKey(now);
  db.transaction(() => {
    const seen = new Map((db.prepare('SELECT email, up, down FROM traffic_seen WHERE panel_id = ?').all(panelId) as { email: string; up: number; down: number }[]).map((r) => [r.email, r]));
    const owner = new Map((db.prepare('SELECT email, customer_id FROM lines WHERE panel_id = ?').all(panelId) as { email: string; customer_id: number }[]).map((r) => [r.email, r.customer_id]));
    const remember = db.prepare('INSERT INTO traffic_seen (panel_id, email, up, down) VALUES (?, ?, ?, ?) ON CONFLICT (panel_id, email) DO UPDATE SET up = excluded.up, down = excluded.down');
    const add = db.prepare(
      `INSERT INTO traffic_daily (day, panel_id, email, customer_id, up, down) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (day, panel_id, email) DO UPDATE SET up = up + excluded.up, down = down + excluded.down, customer_id = excluded.customer_id`,
    );
    for (const c of clients) {
      const before = seen.get(c.email);
      seen.delete(c.email);
      if (c.hasTraffic === false) continue;
      if (before && before.up === c.up && before.down === c.down) continue;
      remember.run(panelId, c.email, c.up, c.down);
      if (!before) continue;
      const up = grown(c.up, before.up);
      const down = grown(c.down, before.down);
      if (up + down > 0) add.run(day, panelId, c.email, owner.get(c.email) ?? null, up, down);
    }
    // 面板上已经没有的客户端:起点不留(同名的再建出来时从头算)
    const forget = db.prepare('DELETE FROM traffic_seen WHERE panel_id = ? AND email = ?');
    for (const email of seen.keys()) forget.run(panelId, email);
  })();
}

/**
 * 一位客户最近 days 天每天的计费用量:各线路(含删掉的)每天的上下行,各乘上所在面板现在的倍率(面板已删的按 1)。
 * 自助页的「每天用量」用它,和订阅里的已用一个口径
 */
export function dailyBilled(db: DB, customerId: number, days: number, now = Date.now()): { days: string[]; bytes: number[] } {
  const list = lastDays(days, now);
  const index = new Map(list.map((d, i) => [d, i]));
  const bytes = list.map(() => 0);
  const rows = db
    .prepare('SELECT t.day, SUM(t.up + t.down) AS total, COALESCE(p.traffic_ratio, 1) AS ratio FROM traffic_daily t LEFT JOIN panels p ON p.id = t.panel_id WHERE t.customer_id = ? AND t.day >= ? GROUP BY t.day, t.panel_id')
    .all(customerId, list[0]) as { day: string; total: number; ratio: number }[];
  for (const r of rows) {
    const i = index.get(r.day);
    if (i !== undefined) bytes[i] += Math.round(r.total * r.ratio);
  }
  return { days: list, bytes };
}

export function pruneTraffic(db: DB, now = Date.now()): void {
  db.prepare('DELETE FROM traffic_daily WHERE day < ?').run(dayKey(now - TRAFFIC_KEEP_DAYS * DAY_MS));
}

export type TrafficBy = 'customer' | 'panel';

export interface TrafficRow {
  /** 汇总时是客户 / 面板的 id(没归入客户的那一行是 0);展开某一个时是 0 */
  id: number;
  name: string;
  /** 客户 / 面板已经删掉了,只剩统计 */
  deleted: boolean;
  up: number;
  down: number;
  /** 每天的上行 + 下行,和 days 一一对应 */
  daily: number[];
}

export interface TrafficReport {
  by: TrafficBy;
  /** 展开的是哪一个(没展开是 null) */
  id: number | null;
  days: string[];
  total: { up: number[]; down: number[] };
  rows: TrafficRow[];
}

/** 最近 days 天(含今天)的日期,从早到晚。按日历日往前数,不按 24 小时减:夏令时那两天不会错位 */
function lastDays(days: number, now: number): string[] {
  const d = new Date(now);
  return Array.from({ length: days }, (_, i) => dayKey(new Date(d.getFullYear(), d.getMonth(), d.getDate() - (days - 1 - i), 12).getTime()));
}

/**
 * 不给 id:每位客户 / 每块面板一行。给了 id:这位客户 / 这块面板名下每个客户端一行(按客户时 id 为 0 = 没归入客户的)。
 * exclude:这些面板上的流量不算(总量、按面板、按客户都不算;按客户时就是客户在这些面板上的线路不算)。只是算的时候跳过,记录不动。
 * customers:只算这些客户的流量(0 = 没归入客户的客户端);按面板时就是每块面板上这几位客户用的。不给或空 = 全部。
 * 行按用量从大到小排。
 */
export function trafficReport(db: DB, opts: { by: TrafficBy; days: number; id?: number | null; exclude?: number[]; customers?: number[] }, now = Date.now()): TrafficReport {
  const { by } = opts;
  const id = opts.id ?? null;
  const days = lastDays(Math.min(Math.max(Math.trunc(opts.days) || 30, 1), TRAFFIC_KEEP_DAYS), now);
  const index = new Map(days.map((d, i) => [d, i]));
  const where = id == null ? '' : by === 'panel' ? 'AND t.panel_id = @id' : id === 0 ? 'AND t.customer_id IS NULL' : 'AND t.customer_id = @id';
  const exclude = opts.exclude?.length ? 'AND t.panel_id NOT IN (SELECT value FROM json_each(@exclude))' : '';
  const only = opts.customers?.length ? 'AND COALESCE(t.customer_id, 0) IN (SELECT value FROM json_each(@customers))' : '';
  const data = db
    .prepare(
      `SELECT t.day, t.panel_id, t.email, t.customer_id, t.up, t.down, p.name AS panel_name, c.name AS customer_name
       FROM traffic_daily t LEFT JOIN panels p ON p.id = t.panel_id LEFT JOIN customers c ON c.id = t.customer_id
       WHERE t.day >= @from ${where} ${exclude} ${only}`,
    )
    .all({ from: days[0], id, exclude: JSON.stringify(opts.exclude ?? []), customers: JSON.stringify(opts.customers ?? []) }) as { day: string; panel_id: number; email: string; customer_id: number | null; up: number; down: number; panel_name: string | null; customer_name: string | null }[];

  const total = { up: days.map(() => 0), down: days.map(() => 0) };
  const rows = new Map<string, TrafficRow>();
  for (const r of data) {
    const i = index.get(r.day);
    if (i === undefined) continue;
    total.up[i] += r.up;
    total.down[i] += r.down;
    const panelName = r.panel_name ?? `已删除的面板 #${r.panel_id}`;
    const customerName = r.customer_id == null ? '没归入客户的客户端' : (r.customer_name ?? `已删除的客户 #${r.customer_id}`);
    let key: string;
    let head: Pick<TrafficRow, 'id' | 'name' | 'deleted'>;
    if (id != null) {
      key = `${r.panel_id}\n${r.email}`;
      // 展开客户:这条线路在哪块面板上;展开面板:这个客户端是谁的
      head = { id: 0, name: by === 'customer' ? `${panelName} · ${r.email}` : r.customer_id == null ? r.email : `${r.email} · ${customerName}`, deleted: false };
    } else if (by === 'panel') {
      key = String(r.panel_id);
      head = { id: r.panel_id, name: panelName, deleted: r.panel_name == null };
    } else {
      key = String(r.customer_id ?? 0);
      head = { id: r.customer_id ?? 0, name: customerName, deleted: r.customer_id != null && r.customer_name == null };
    }
    let row = rows.get(key);
    if (!row) rows.set(key, (row = { ...head, up: 0, down: 0, daily: days.map(() => 0) }));
    row.up += r.up;
    row.down += r.down;
    row.daily[i] += r.up + r.down;
  }
  return { by, id, days, total, rows: [...rows.values()].sort((a, b) => b.up + b.down - (a.up + a.down) || a.name.localeCompare(b.name)) };
}
