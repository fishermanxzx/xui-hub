// 客户与线路的存取。线路 = 客户在某块面板上的一个 client,直连或中转(带出口)。

import { randomBytes } from 'node:crypto';
import type { DB } from '../db';
import { InputError } from '../panels/repo';

export type LineKind = 'direct' | 'relay';
export type CustomerState = 'active' | 'expired' | 'over_quota';

export interface Line {
  id: number;
  customer_id: number;
  kind: LineKind;
  panel_id: number;
  panel_name: string;
  inbound_id: number;
  inbound_remark: string;
  protocol: string;
  email: string;
  exit_kind: 'panel' | 'socks' | null;
  exit_panel_id: number | null;
  exit_panel_name: string | null;
  exit_port: number | null;
  exit_socks_id: number | null;
  exit_socks_name: string | null;
  exit_label: string;
  created_at: number;
  /** 最近一次同步到的客户端流量与状态 */
  up: number;
  down: number;
  enable: boolean;
  auto_disabled: boolean;
  last_online: number;
  synced_at: number | null;
}

export interface Customer {
  id: number;
  name: string;
  remark: string;
  /** 总额度(字节),0 = 不限 */
  quota_bytes: number;
  /** 到期时间(毫秒),0 = 不限期 */
  expire_at: number;
  /** 每月几号清零流量(1-28),0 = 不清零 */
  reset_day: number;
  /** 上次按月清零的时间 */
  last_reset_at: number;
  /** 订阅链接 /sub/<token> 里的 token,每个客户一个;重置后旧链接失效 */
  sub_token: string;
  /** 上次拉取订阅的时间和客户端(User-Agent) */
  sub_fetched_at: number | null;
  sub_fetched_ua: string | null;
  created_at: number;
  updated_at: number;
}

export type CustomerView = Customer & {
  lines: Line[];
  used_up: number;
  used_down: number;
  used: number;
  state: CustomerState;
};

export interface CustomerInput {
  name?: unknown;
  remark?: unknown;
  quota_bytes?: unknown;
  expire_at?: unknown;
  reset_day?: unknown;
}

/** 客户状态:到期 > 超额 > 正常 */
export function customerState(c: { quota_bytes: number; expire_at: number }, used: number, now = Date.now()): CustomerState {
  if (c.expire_at > 0 && c.expire_at <= now) return 'expired';
  if (c.quota_bytes > 0 && used >= c.quota_bytes) return 'over_quota';
  return 'active';
}

function nonNegativeInt(value: unknown, label: string): number {
  if (value == null || value === '') return 0;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new InputError(`${label}必须是大于等于 0 的整数`);
  return n;
}

function validResetDay(value: unknown): number {
  if (value == null || value === '') return 0;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 28) throw new InputError('每月清零日只能是 1 到 28,留空 = 不清零');
  return n;
}

function validName(value: unknown): string {
  const v = String(value ?? '').trim();
  if (!v) throw new InputError('客户名称不能为空');
  if (v.length > 64) throw new InputError('客户名称不能超过 64 个字符');
  return v;
}

const LINE_SQL = `
  SELECT l.*, p.name AS panel_name, ep.name AS exit_panel_name, es.name AS exit_socks_name
  FROM lines l
  JOIN panels p ON p.id = l.panel_id
  LEFT JOIN panels ep ON ep.id = l.exit_panel_id
  LEFT JOIN socks_proxies es ON es.id = l.exit_socks_id`;

function toLine(row: any): Line {
  return {
    id: row.id,
    customer_id: row.customer_id,
    kind: row.kind,
    panel_id: row.panel_id,
    panel_name: row.panel_name,
    inbound_id: row.inbound_id,
    inbound_remark: row.inbound_remark,
    protocol: row.protocol,
    email: row.email,
    exit_kind: row.exit_kind ?? null,
    exit_panel_id: row.exit_panel_id ?? null,
    exit_panel_name: row.exit_panel_name ?? null,
    exit_port: row.exit_port ?? null,
    exit_socks_id: row.exit_socks_id ?? null,
    exit_socks_name: row.exit_socks_name ?? null,
    exit_label: row.exit_label,
    created_at: row.created_at,
    up: row.up ?? 0,
    down: row.down ?? 0,
    enable: row.enable !== 0,
    auto_disabled: row.auto_disabled === 1,
    last_online: row.last_online ?? 0,
    synced_at: row.synced_at ?? null,
  };
}

export function linesOf(db: DB, customerId: number): Line[] {
  return (db.prepare(`${LINE_SQL} WHERE l.customer_id = ? ORDER BY l.id`).all(customerId) as any[]).map(toLine);
}

export function getLine(db: DB, id: number): Line | undefined {
  const row = db.prepare(`${LINE_SQL} WHERE l.id = ?`).get(id);
  return row ? toLine(row) : undefined;
}

/** 给客户配上线路和用量。多个客户时一次查出全部线路再分组,不逐个查 */
function withLines(db: DB, rows: any[], now = Date.now()): CustomerView[] {
  const all = rows.length === 1 ? linesOf(db, rows[0].id) : (db.prepare(`${LINE_SQL} ORDER BY l.id`).all() as any[]).map(toLine);
  const byCustomer = new Map<number, Line[]>();
  for (const l of all) byCustomer.set(l.customer_id, [...(byCustomer.get(l.customer_id) ?? []), l]);
  return rows.map((c) => {
    const lines = byCustomer.get(c.id) ?? [];
    const used_up = lines.reduce((s, l) => s + l.up, 0);
    const used_down = lines.reduce((s, l) => s + l.down, 0);
    const used = used_up + used_down;
    return { ...c, lines, used_up, used_down, used, state: customerState(c, used, now) };
  });
}

export function listCustomers(db: DB): CustomerView[] {
  return withLines(db, db.prepare('SELECT * FROM customers ORDER BY name COLLATE NOCASE').all() as any[]);
}

export function getCustomer(db: DB, id: number): CustomerView | undefined {
  const row = db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
  return row ? withLines(db, [row])[0] : undefined;
}

const newSubToken = () => randomBytes(18).toString('base64url');

export function createCustomer(db: DB, input: CustomerInput, now = Date.now()): number {
  const info = db
    .prepare('INSERT INTO customers (name, remark, quota_bytes, expire_at, reset_day, last_reset_at, sub_token, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(validName(input.name), String(input.remark ?? '').trim(), nonNegativeInt(input.quota_bytes, '额度'), nonNegativeInt(input.expire_at, '到期时间'), validResetDay(input.reset_day), now, newSubToken(), now, now);
  return Number(info.lastInsertRowid);
}

export function customerIdBySubToken(db: DB, token: string): number | undefined {
  return (db.prepare('SELECT id FROM customers WHERE sub_token = ?').get(token) as { id: number } | undefined)?.id;
}

/** 重置订阅链接:换一个 token,客户手里的旧链接立即失效 */
export function resetSubToken(db: DB, id: number, now = Date.now()): void {
  if (!db.prepare('UPDATE customers SET sub_token = ?, updated_at = ? WHERE id = ?').run(newSubToken(), now, id).changes) throw new InputError('客户不存在');
}

export function touchSubFetch(db: DB, id: number, ua: string, now = Date.now()): void {
  db.prepare('UPDATE customers SET sub_fetched_at = ?, sub_fetched_ua = ? WHERE id = ?').run(now, ua.slice(0, 300), id);
}

export function updateCustomer(db: DB, id: number, input: CustomerInput, now = Date.now()): void {
  const cur = db.prepare('SELECT * FROM customers WHERE id = ?').get(id) as any;
  if (!cur) throw new InputError('客户不存在');
  const resetDay = input.reset_day === undefined ? cur.reset_day : validResetDay(input.reset_day);
  db.prepare('UPDATE customers SET name = ?, remark = ?, quota_bytes = ?, expire_at = ?, reset_day = ?, last_reset_at = ?, updated_at = ? WHERE id = ?').run(
    input.name === undefined ? cur.name : validName(input.name),
    input.remark === undefined ? cur.remark : String(input.remark ?? '').trim(),
    input.quota_bytes === undefined ? cur.quota_bytes : nonNegativeInt(input.quota_bytes, '额度'),
    input.expire_at === undefined ? cur.expire_at : nonNegativeInt(input.expire_at, '到期时间'),
    resetDay,
    // 刚设上 / 改了清零日:从现在起算,下一个清零日才清,不会设完马上把这期清掉
    resetDay !== cur.reset_day ? now : cur.last_reset_at,
    now,
    id,
  );
}

export function markReset(db: DB, id: number, now = Date.now()): void {
  db.prepare('UPDATE customers SET last_reset_at = ? WHERE id = ?').run(now, id);
}

/**
 * 本期的起点:now 之前(含当天)最近一个 reset_day 号的 0 点(本机时区)。
 * 上次清零早于它就该清零了。服务停了几天再起来也只清一次,不会把中间漏掉的几期各清一遍
 */
export function periodStart(resetDay: number, now = Date.now()): number {
  const d = new Date(now);
  const start = new Date(d.getFullYear(), d.getMonth(), resetDay);
  if (start.getTime() > now) start.setMonth(start.getMonth() - 1);
  return start.getTime();
}

/** 到了清零日还没清的客户 */
export function customersDueReset(db: DB, now = Date.now()): CustomerView[] {
  return listCustomers(db).filter((c) => c.reset_day > 0 && c.last_reset_at < periodStart(c.reset_day, now));
}

/** 同步到的客户端状态写回线路(面板上没有这个客户端时 present = false,流量保持上次的值) */
export function updateLineStats(db: DB, lineId: number, s: { up: number; down: number; enable: boolean; last_online: number }, now = Date.now()): void {
  db.prepare('UPDATE lines SET up = ?, down = ?, enable = ?, last_online = ?, synced_at = ? WHERE id = ?').run(s.up, s.down, s.enable ? 1 : 0, s.last_online, now, lineId);
}

export function markLineAuto(db: DB, lineId: number, autoDisabled: boolean, enable: boolean): void {
  db.prepare('UPDATE lines SET auto_disabled = ?, enable = ? WHERE id = ?').run(autoDisabled ? 1 : 0, enable ? 1 : 0, lineId);
}

export function zeroLineTraffic(db: DB, lineId: number): void {
  db.prepare('UPDATE lines SET up = 0, down = 0 WHERE id = ?').run(lineId);
}

export function linesOnPanel(db: DB, panelId: number): Line[] {
  return (db.prepare(`${LINE_SQL} WHERE l.panel_id = ? ORDER BY l.id`).all(panelId) as any[]).map(toLine);
}

/** 面板上这个 email 的 client 是不是某位客户的线路 */
export function lineByEmail(db: DB, panelId: number, email: string): Line | undefined {
  const row = db.prepare(`${LINE_SQL} WHERE l.panel_id = ? AND l.email = ?`).get(panelId, email);
  return row ? toLine(row) : undefined;
}

/** 出口是这个 SOCKS 的中转线路 */
export function linesViaSocks(db: DB, socksId: number): Line[] {
  return (db.prepare(`${LINE_SQL} WHERE l.exit_socks_id = ? ORDER BY l.id`).all(socksId) as any[]).map(toLine);
}

export function deleteCustomer(db: DB, id: number): void {
  if (!db.prepare('DELETE FROM customers WHERE id = ?').run(id).changes) throw new InputError('客户不存在');
}

export interface LineInsert {
  customer_id: number;
  kind: LineKind;
  panel_id: number;
  inbound_id: number;
  inbound_remark: string;
  protocol: string;
  email: string;
  exit_kind?: 'panel' | 'socks' | null;
  exit_panel_id?: number | null;
  exit_port?: number | null;
  exit_socks_id?: number | null;
  exit_label?: string;
}

export function addLine(db: DB, l: LineInsert, now = Date.now()): Line {
  const info = db
    .prepare(
      `INSERT INTO lines (customer_id, kind, panel_id, inbound_id, inbound_remark, protocol, email, exit_kind, exit_panel_id, exit_port, exit_socks_id, exit_label, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(l.customer_id, l.kind, l.panel_id, l.inbound_id, l.inbound_remark, l.protocol, l.email, l.exit_kind ?? null, l.exit_panel_id ?? null, l.exit_port ?? null, l.exit_socks_id ?? null, l.exit_label ?? '', now);
  return getLine(db, Number(info.lastInsertRowid))!;
}

export function deleteLine(db: DB, id: number): void {
  if (!db.prepare('DELETE FROM lines WHERE id = ?').run(id).changes) throw new InputError('线路不存在');
}
