// 客户与线路绑定。客户的已用流量由同步服务按增量累加,这里只做查询、编辑和绑定关系维护。

import { randomBytes } from 'node:crypto';
import type { DB } from '../db';
import { InputError, money, type PanelRole } from '../panels/repo';
import { hourStart } from '../sync/delta';

export type CustomerStatus = 'active' | 'disabled';
/** 计算出的实际状态 */
export type CustomerState = 'active' | 'disabled' | 'expired' | 'over_quota';

export interface LineView {
  binding_id: number;
  panel_id: number;
  panel_name: string;
  panel_role: PanelRole;
  email: string;
  comment: string;
  enable: boolean;
  up: number;
  down: number;
  /** 面板上 client 的额度 / 到期:应当都是 0(到期和额度只由本系统管),不是 0 时后台提示 */
  panel_total_bytes: number;
  panel_expiry_ms: number;
  last_online: number;
  missing: boolean;
}

export interface CustomerView {
  id: number;
  name: string;
  remark: string;
  monthly_price: number | null;
  quota_bytes: number;
  expire_at: number;
  status: CustomerStatus;
  state: CustomerState;
  used_up: number;
  used_down: number;
  used: number;
  /** null = 不限额 */
  remaining: number | null;
  usage_reset_at: number;
  /** 开启"每月按到期日重置流量"的时间,0 = 没开 */
  monthly_reset_at: number;
  /** 订阅链接 /sub/<token> 里的 token,每个客户一个;重置后旧链接失效 */
  sub_token: string;
  /** 客户上次拉取订阅的时间和客户端(User-Agent) */
  sub_fetched_at: number | null;
  sub_fetched_ua: string | null;
  created_at: number;
  updated_at: number;
  lines: LineView[];
}

export interface CustomerInput {
  name?: string;
  remark?: string;
  monthly_price?: number | null;
  quota_bytes?: number;
  expire_at?: number;
  status?: CustomerStatus;
  /** 每月按到期日重置流量 */
  monthly_reset?: boolean;
}

export function customerState(c: { status: CustomerStatus; quota_bytes: number; expire_at: number; used: number }, now: number): CustomerState {
  if (c.status === 'disabled') return 'disabled';
  if (c.expire_at > 0 && c.expire_at <= now) return 'expired';
  if (c.quota_bytes > 0 && c.used >= c.quota_bytes) return 'over_quota';
  return 'active';
}

function nonNegativeInt(value: unknown, label: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new InputError(`${label}必须是大于等于 0 的数字`);
  return Math.trunc(n);
}

function validName(value: unknown): string {
  const name = String(value ?? '').trim();
  if (!name) throw new InputError('客户名称不能为空');
  if (name.length > 100) throw new InputError('客户名称过长');
  return name;
}

function validStatus(value: unknown): CustomerStatus {
  if (value !== 'active' && value !== 'disabled') throw new InputError('status 只能是 active 或 disabled');
  return value;
}

const LINE_SQL = `
  SELECT b.id AS binding_id, b.customer_id, b.panel_id, p.name AS panel_name, p.role AS panel_role, b.email,
         c.comment, c.enable, c.up, c.down, c.total_bytes, c.expiry_ms, c.last_online, c.updated_at, c.missing_since
  FROM bindings b
  JOIN panels p ON p.id = b.panel_id
  LEFT JOIN client_counters c ON c.panel_id = b.panel_id AND c.email = b.email`;

function toLine(row: any): LineView {
  return {
    binding_id: row.binding_id,
    panel_id: row.panel_id,
    panel_name: row.panel_name,
    panel_role: row.panel_role,
    email: row.email,
    comment: row.comment ?? '',
    enable: row.enable == null ? false : row.enable === 1,
    up: row.up ?? 0,
    down: row.down ?? 0,
    panel_total_bytes: row.total_bytes ?? 0,
    panel_expiry_ms: row.expiry_ms ?? 0,
    last_online: row.last_online ?? 0,
    // 计数器缺失(从未同步到)或面板上已找不到该 client
    missing: row.updated_at == null || row.missing_since != null,
  };
}

function toView(row: any, lines: LineView[], now: number): CustomerView {
  const used = row.used_up + row.used_down;
  return {
    id: row.id,
    name: row.name,
    remark: row.remark,
    monthly_price: row.monthly_price,
    quota_bytes: row.quota_bytes,
    expire_at: row.expire_at,
    status: row.status,
    state: customerState({ status: row.status, quota_bytes: row.quota_bytes, expire_at: row.expire_at, used }, now),
    used_up: row.used_up,
    used_down: row.used_down,
    used,
    remaining: row.quota_bytes > 0 ? Math.max(0, row.quota_bytes - used) : null,
    usage_reset_at: row.usage_reset_at,
    monthly_reset_at: row.monthly_reset_at ?? 0,
    sub_token: row.sub_token,
    sub_fetched_at: row.sub_fetched_at ?? null,
    sub_fetched_ua: row.sub_fetched_ua ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    lines,
  };
}

export function listCustomers(db: DB, now = Date.now()): CustomerView[] {
  const lines = new Map<number, LineView[]>();
  for (const row of db.prepare(`${LINE_SQL} ORDER BY p.role DESC, p.name`).all() as any[]) {
    const list = lines.get(row.customer_id) ?? [];
    list.push(toLine(row));
    lines.set(row.customer_id, list);
  }
  return (db.prepare('SELECT * FROM customers ORDER BY name COLLATE NOCASE, id').all() as any[]).map((row) =>
    toView(row, lines.get(row.id) ?? [], now),
  );
}

export function getCustomer(db: DB, id: number, now = Date.now()): CustomerView | undefined {
  const row = db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
  if (!row) return undefined;
  const lines = (db.prepare(`${LINE_SQL} WHERE b.customer_id = ? ORDER BY p.role DESC, p.name`).all(id) as any[]).map(toLine);
  return toView(row, lines, now);
}

function requireCustomer(db: DB, id: number): void {
  if (!db.prepare('SELECT 1 FROM customers WHERE id = ?').get(id)) throw new InputError('客户不存在');
}

/** 订阅链接里的 token:每个客户一个,随机生成 */
function newSubToken(): string {
  return randomBytes(18).toString('base64url');
}

export function customerIdBySubToken(db: DB, token: string): number | undefined {
  return (db.prepare('SELECT id FROM customers WHERE sub_token = ?').get(token) as { id: number } | undefined)?.id;
}

/** 重置订阅链接:换一个 token,客户手里的旧链接立即失效 */
export function resetSubToken(db: DB, id: number, now = Date.now()): void {
  requireCustomer(db, id);
  db.prepare('UPDATE customers SET sub_token = ?, updated_at = ? WHERE id = ?').run(newSubToken(), now, id);
}

export function touchSubFetch(db: DB, id: number, ua: string, now = Date.now()): void {
  db.prepare('UPDATE customers SET sub_fetched_at = ?, sub_fetched_ua = ? WHERE id = ?').run(now, ua.slice(0, 300), id);
}

export function createCustomer(db: DB, input: CustomerInput, now = Date.now()): number {
  const info = db
    .prepare(
      `INSERT INTO customers (name, remark, monthly_price, quota_bytes, expire_at, status, usage_reset_at, sub_token, monthly_reset_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      validName(input.name),
      String(input.remark ?? '').trim(),
      money(input.monthly_price, '月费'),
      nonNegativeInt(input.quota_bytes ?? 0, '额度'),
      nonNegativeInt(input.expire_at ?? 0, '到期时间'),
      validStatus(input.status ?? 'active'),
      now,
      newSubToken(),
      input.monthly_reset ? now : 0,
      now,
      now,
    );
  return Number(info.lastInsertRowid);
}

export function updateCustomer(db: DB, id: number, patch: CustomerInput, now = Date.now()): void {
  const cur = db.prepare('SELECT * FROM customers WHERE id = ?').get(id) as any;
  if (!cur) throw new InputError('客户不存在');
  db.prepare(
    `UPDATE customers SET name = ?, remark = ?, monthly_price = ?, quota_bytes = ?, expire_at = ?, status = ?,
            monthly_reset_at = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    patch.name !== undefined ? validName(patch.name) : cur.name,
    patch.remark !== undefined ? String(patch.remark).trim() : cur.remark,
    patch.monthly_price !== undefined ? money(patch.monthly_price, '月费') : cur.monthly_price,
    patch.quota_bytes !== undefined ? nonNegativeInt(patch.quota_bytes, '额度') : cur.quota_bytes,
    patch.expire_at !== undefined ? nonNegativeInt(patch.expire_at, '到期时间') : cur.expire_at,
    patch.status !== undefined ? validStatus(patch.status) : cur.status,
    // 已开着就保留原来的开启时间
    patch.monthly_reset === undefined ? cur.monthly_reset_at : patch.monthly_reset ? cur.monthly_reset_at || now : 0,
    now,
    id,
  );
}

/** 删除客户和他的线路绑定(订阅链接随之失效)。面板上的 client 不在这里处理(先由调用方删除) */
export function deleteCustomer(db: DB, id: number): void {
  requireCustomer(db, id);
  db.prepare('DELETE FROM customers WHERE id = ?').run(id);
}

export function resetUsage(db: DB, id: number, now = Date.now()): void {
  requireCustomer(db, id);
  db.prepare('UPDATE customers SET used_up = 0, used_down = 0, usage_reset_at = ?, updated_at = ? WHERE id = ?').run(now, now, id);
}

/**
 * 给客户绑定一条线路(某面板上的一个 client)。
 * includeCurrentUsage:把该 client 当前面板上的已用量计入客户(导入存量客户时使用);否则只统计之后的增量。
 */
export function addBinding(db: DB, customerId: number, panelId: number, email: string, includeCurrentUsage: boolean, now = Date.now()): number {
  return db.transaction(() => {
    requireCustomer(db, customerId);
    const counter = db.prepare('SELECT up, down FROM client_counters WHERE panel_id = ? AND email = ?').get(panelId, email) as
      | { up: number; down: number }
      | undefined;
    if (!counter) throw new InputError(`面板上没有同步到 client:${email}`);
    const owner = db
      .prepare('SELECT c.name FROM bindings b JOIN customers c ON c.id = b.customer_id WHERE b.panel_id = ? AND b.email = ?')
      .get(panelId, email) as { name: string } | undefined;
    if (owner) throw new InputError(`${email} 已绑定到客户「${owner.name}」`);
    const info = db.prepare('INSERT INTO bindings (customer_id, panel_id, email, created_at) VALUES (?, ?, ?, ?)').run(customerId, panelId, email, now);
    if (includeCurrentUsage) {
      db.prepare('UPDATE customers SET used_up = used_up + ?, used_down = used_down + ?, updated_at = ? WHERE id = ?').run(
        counter.up,
        counter.down,
        now,
        customerId,
      );
    }
    return Number(info.lastInsertRowid);
  })();
}

/** 解绑不回退客户已用量,只是之后的增量不再计入 */
export function removeBinding(db: DB, customerId: number, bindingId: number): void {
  if (db.prepare('DELETE FROM bindings WHERE id = ? AND customer_id = ?').run(bindingId, customerId).changes === 0) {
    throw new InputError('线路不存在');
  }
}

export interface DailyUsage {
  days: string[];
  totals: number[];
  lines: { panel_name: string; email: string; values: number[] }[];
}

function dayLabel(ts: number, tzOffsetMin: number): string {
  return new Date(ts + tzOffsetMin * 60_000).toISOString().slice(0, 10);
}

/** 最近 N 天(含今天)的日期标签,从旧到新 */
function dayLabels(days: number, tzOffsetMin: number, now: number): string[] {
  const labels: string[] = [];
  for (let i = days - 1; i >= 0; i--) labels.push(dayLabel(now - i * 86_400_000, tzOffsetMin));
  return labels;
}

/** 最近 N 天(含今天)按天、按线路汇总的客户流量 */
export function customerDailyUsage(db: DB, id: number, days: number, tzOffsetMin: number, now = Date.now()): DailyUsage {
  const labels = dayLabels(days, tzOffsetMin, now);
  const index = new Map(labels.map((label, i) => [label, i]));
  const since = hourStart(now - days * 86_400_000);
  const rows = db
    .prepare(
      `SELECT t.hour, t.up, t.down, t.email, COALESCE(p.name, d.name || '（已删除）', '#' || t.panel_id) AS panel_name
       FROM traffic_hourly t LEFT JOIN panels p ON p.id = t.panel_id LEFT JOIN deleted_panels d ON d.id = t.panel_id
       WHERE t.customer_id = ? AND t.hour >= ?`,
    )
    .all(id, since) as any[];
  const totals = labels.map(() => 0);
  const lines = new Map<string, { panel_name: string; email: string; values: number[] }>();
  for (const row of rows) {
    const i = index.get(dayLabel(row.hour, tzOffsetMin));
    if (i == null) continue;
    const bytes = row.up + row.down;
    totals[i] += bytes;
    const key = `${row.panel_name}\u0000${row.email}`;
    const line = lines.get(key) ?? { panel_name: row.panel_name, email: row.email, values: labels.map(() => 0) };
    line.values[i] += bytes;
    lines.set(key, line);
  }
  return { days: labels, totals, lines: [...lines.values()] };
}

export interface OverallDailyUsage {
  days: string[];
  /** 当天全体客户的流量(字节) */
  bytes: number[];
  /** 当天有流量的客户数 */
  customers: number[];
  /** 当天其中经中转机的流量(字节);其余是直连落地 */
  relay: number[];
}

/** 统计时排除的面板:拼成 SQL 条件和参数 */
function panelExclusion(exclude: readonly number[]): { sql: string; args: number[] } {
  const ids = [...new Set(exclude)];
  return ids.length ? { sql: ` AND panel_id NOT IN (${ids.map(() => '?').join(', ')})`, args: ids } : { sql: '', args: [] };
}

/**
 * 最近 N 天(含今天)全体客户按天的总流量、有流量的客户数和其中经中转的流量;未绑定客户的线路(customer_id = 0)不算。
 * 中转按流量发生时面板登记的类型算(改类型不影响以前的)。excludePanels:不算这些面板上的流量(看排除某些服务器后的情况)
 */
export function overallDailyUsage(
  db: DB,
  days: number,
  tzOffsetMin: number,
  now = Date.now(),
  excludePanels: readonly number[] = [],
): OverallDailyUsage {
  const labels = dayLabels(days, tzOffsetMin, now);
  const index = new Map(labels.map((label, i) => [label, i]));
  const ex = panelExclusion(excludePanels);
  const rows = db
    .prepare(
      `SELECT hour, customer_id, SUM(up + down) AS bytes, SUM(CASE WHEN relay = 1 THEN up + down ELSE 0 END) AS relay
       FROM traffic_hourly
       WHERE customer_id > 0 AND hour >= ?${ex.sql} GROUP BY hour, customer_id`,
    )
    .all(hourStart(now - days * 86_400_000), ...ex.args) as { hour: number; customer_id: number; bytes: number; relay: number }[];
  const bytes = labels.map(() => 0);
  const relay = labels.map(() => 0);
  const active = labels.map(() => new Set<number>());
  for (const row of rows) {
    const i = index.get(dayLabel(row.hour, tzOffsetMin));
    if (i == null) continue;
    bytes[i] += row.bytes;
    relay[i] += row.relay;
    if (row.bytes > 0) active[i].add(row.customer_id);
  }
  return { days: labels, bytes, customers: active.map((s) => s.size), relay };
}

export interface DailySeries {
  days: string[];
  /** 每个面板 / 客户每天的流量(字节) */
  series: { id: number; values: number[] }[];
}

/**
 * 最近 N 天(含今天)按面板或按客户、按天的流量。
 * 按面板:含没绑定客户的 client,没有流量的面板也列出;按客户:只列有流量的客户。已删除的面板 / 客户不列。
 * excludePanels 里的面板不算(按面板时也不列)
 */
export function dailyUsageBy(
  db: DB,
  by: 'panel' | 'customer',
  days: number,
  tzOffsetMin: number,
  now = Date.now(),
  excludePanels: readonly number[] = [],
): DailySeries {
  const labels = dayLabels(days, tzOffsetMin, now);
  const index = new Map(labels.map((label, i) => [label, i]));
  const table = by === 'panel' ? 'panels' : 'customers';
  const excluded = new Set(excludePanels);
  const ids = (db.prepare(`SELECT id FROM ${table} ORDER BY id`).all() as { id: number }[])
    .map((r) => r.id)
    .filter((id) => by !== 'panel' || !excluded.has(id));
  const known = new Set(ids);
  const series = new Map<number, number[]>(by === 'panel' ? ids.map((id) => [id, labels.map(() => 0)]) : []);
  const col = by === 'panel' ? 'panel_id' : 'customer_id';
  const ex = panelExclusion(excludePanels);
  const rows = db
    .prepare(`SELECT hour, ${col} AS id, SUM(up + down) AS bytes FROM traffic_hourly WHERE hour >= ?${ex.sql} GROUP BY hour, ${col}`)
    .all(hourStart(now - days * 86_400_000), ...ex.args) as { hour: number; id: number; bytes: number }[];
  for (const row of rows) {
    const i = index.get(dayLabel(row.hour, tzOffsetMin));
    if (i == null || !known.has(row.id) || row.bytes <= 0) continue;
    const values = series.get(row.id) ?? labels.map(() => 0);
    values[i] += row.bytes;
    series.set(row.id, values);
  }
  return { days: labels, series: [...series].map(([id, values]) => ({ id, values })) };
}

export interface ClientRow {
  panel_id: number;
  panel_name: string;
  panel_role: PanelRole;
  email: string;
  comment: string;
  enable: boolean;
  up: number;
  down: number;
  total_bytes: number;
  expiry_ms: number;
  missing: boolean;
  customer_id: number | null;
  customer_name: string | null;
}

export function listClientRows(db: DB, opts: { unboundOnly?: boolean } = {}): ClientRow[] {
  const rows = db
    .prepare(
      `SELECT c.panel_id, p.name AS panel_name, p.role AS panel_role, c.email, c.comment, c.enable, c.up, c.down,
              c.total_bytes, c.expiry_ms, c.missing_since, b.customer_id, cu.name AS customer_name
       FROM client_counters c
       JOIN panels p ON p.id = c.panel_id
       LEFT JOIN bindings b ON b.panel_id = c.panel_id AND b.email = c.email
       LEFT JOIN customers cu ON cu.id = b.customer_id
       ${opts.unboundOnly ? 'WHERE b.id IS NULL' : ''}
       ORDER BY p.role DESC, p.name, c.email`,
    )
    .all() as any[];
  return rows.map((r) => ({
    panel_id: r.panel_id,
    panel_name: r.panel_name,
    panel_role: r.panel_role,
    email: r.email,
    comment: r.comment ?? '',
    enable: r.enable === 1,
    up: r.up,
    down: r.down,
    total_bytes: r.total_bytes,
    expiry_ms: r.expiry_ms,
    missing: r.missing_since != null,
    customer_id: r.customer_id ?? null,
    customer_name: r.customer_name ?? null,
  }));
}
