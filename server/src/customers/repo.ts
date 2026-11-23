// 客户与线路的存取。线路 = 客户在某块面板上的一个 client,直出或走 SOCKS 出口(exit_kind = socks;旧版本留下的 exit_kind = panel 照常生效)。

import { randomBytes } from 'node:crypto';
import type { DB } from '../db';
import { InputError, validCost } from '../panels/repo';
import { customLinksByCustomer, setCustomLinks } from '../subscription/customLinks';
import { validTemplate } from '../subscription/templates';
import type { RouteHop } from '../lines/routes';
import type { LineRule } from '../lines/rules';
import { setUpstreams, upstreamsByCustomer, validUpstreamMode, type UpstreamMode, type UpstreamView } from '../subscription/upstream';

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
  /** 自定义节点名:订阅和分享链接里代替面板生成的名字,空 = 用面板的 */
  node_name: string;
  /** 面板上实际的出口(按 Xray 路由规则顺序,同步时读);null = 还没读到 */
  routes: RouteHop[] | null;
  routes_at: number;
  /** 在 xui-hub 里配的出口规则(写到面板上);没命中的流量走原来的出口 */
  rules: LineRule[];
  created_at: number;
  /** 上次在 xui-hub 里清零的时间(0 = 没清过) */
  zeroed_at: number;
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
  /** 按月重置流量:0 = 不重置。有到期时间时重置日跟着到期日走(每月到了到期日的那个时刻),这个数只在没有到期时间时用(每月几号 0 点,1-28) */
  reset_day: number;
  /** 上次按月清零的时间 */
  last_reset_at: number;
  /** Clash 订阅模板:'' = 默认,内置模板 id,或自定义 https 地址 */
  sub_template: string;
  /** 能拉订阅的设备数上限,0 = 不限 */
  limit_devices: number;
  /** 月费(每月收多少),null = 没填;只用来记账 */
  monthly_fee: number | null;
  /** 流量倍率:计费用量 = 实际流量 × 倍率,默认 1 */
  traffic_ratio: number;
  /** 结转的实际流量(删掉的线路、面板上被清零前的计数、手动调整),清零时一起清;可以是负数(手动减过) */
  carried_up: number;
  carried_down: number;
  /** 订阅链接 /sub/<token> 里的 token,每个客户一个;重置后旧链接失效 */
  sub_token: string;
  /** 上次拉取订阅的时间和客户端(User-Agent) */
  sub_fetched_at: number | null;
  sub_fetched_ua: string | null;
  /** 外部订阅的用法:merge = 和自己线路的节点一起给,replace = 只给外部订阅的 */
  upstream_mode: UpstreamMode;
  /** 订阅里的流量和到期用外部订阅给的(subscription-userinfo) */
  upstream_userinfo: boolean;
  created_at: number;
  updated_at: number;
}

export type CustomerView = Customer & {
  lines: Line[];
  /** 本期实际流量 = 各线路之和 + 结转 */
  actual_up: number;
  actual_down: number;
  actual_used: number;
  /** 本期计费用量 = 实际 × 倍率;订阅里显示的、额度判断用的都是它 */
  used_up: number;
  used_down: number;
  used: number;
  state: CustomerState;
  /** 下次按月重置流量的时间(毫秒),0 = 没开 */
  next_reset_at: number;
  /** 自定义订阅链接(路径 + 参数),访问它们和访问 /sub/<token> 一样 */
  sub_links: string[];
  /** 外部订阅 */
  upstreams: UpstreamView[];
};

export interface CustomerInput {
  name?: unknown;
  remark?: unknown;
  quota_bytes?: unknown;
  expire_at?: unknown;
  reset_day?: unknown;
  sub_template?: unknown;
  limit_devices?: unknown;
  /** 月费:空 = 不填 */
  monthly_fee?: unknown;
  /** 流量倍率:空 = 1 */
  traffic_ratio?: unknown;
  /** 自定义订阅链接:整组替换,地址数组或按行分隔的字符串 */
  sub_links?: unknown;
  /** 外部订阅:整组替换,数组(每项是地址或 { url, node_name })或按行分隔的地址 */
  upstreams?: unknown;
  upstream_mode?: unknown;
  upstream_userinfo?: unknown;
}

/** 客户状态:到期 > 超额 > 正常 */
export function customerState(c: { quota_bytes: number; expire_at: number }, used: number, now = Date.now()): CustomerState {
  if (c.expire_at > 0 && c.expire_at <= now) return 'expired';
  if (c.quota_bytes > 0 && used >= c.quota_bytes) return 'over_quota';
  return 'active';
}

/** 流量倍率:0.01 到 100,保留两位小数;空 = 1 */
export function validRatio(value: unknown): number {
  if (value == null || value === '') return 1;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0.01 || n > 100) throw new InputError('流量倍率要是 0.01 到 100 之间的数,留空 = 1');
  return Math.round(n * 100) / 100;
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

function validLimitDevices(value: unknown): number {
  if (value == null || value === '') return 0;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 100) throw new InputError('设备数上限只能是 0 到 100,0 = 不限');
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

function parseRules(v: unknown): LineRule[] {
  try {
    const r = typeof v === 'string' ? JSON.parse(v) : [];
    return Array.isArray(r) ? r : [];
  } catch {
    return [];
  }
}

function parseRoutes(v: unknown): RouteHop[] | null {
  if (typeof v !== 'string' || !v) return null;
  try {
    const r = JSON.parse(v);
    return Array.isArray(r) ? r : null;
  } catch {
    return null;
  }
}

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
    node_name: row.node_name ?? '',
    routes: parseRoutes(row.routes),
    routes_at: row.routes_at ?? 0,
    rules: parseRules(row.rules),
    created_at: row.created_at,
    zeroed_at: row.zeroed_at ?? 0,
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
  const links = customLinksByCustomer(db, rows.length === 1 ? rows[0].id : undefined);
  const upstreams = upstreamsByCustomer(db, rows.length === 1 ? rows[0].id : undefined);
  // limit_ip 是 0.9.0 留下的列(当时往面板写 limitIp),早已不用,不往外带
  return rows.map(({ limit_ip: _unused, ...c }) => {
    const lines = byCustomer.get(c.id) ?? [];
    // 手动减过时结转是负数,加起来不让它小于 0
    const actual_up = Math.max(0, lines.reduce((s, l) => s + l.up, 0) + (c.carried_up ?? 0));
    const actual_down = Math.max(0, lines.reduce((s, l) => s + l.down, 0) + (c.carried_down ?? 0));
    const ratio = c.traffic_ratio ?? 1;
    const used_up = Math.round(actual_up * ratio);
    const used_down = Math.round(actual_down * ratio);
    const used = used_up + used_down;
    return {
      ...c,
      upstream_userinfo: !!c.upstream_userinfo,
      monthly_fee: c.monthly_fee ?? null,
      traffic_ratio: ratio,
      carried_up: c.carried_up ?? 0,
      carried_down: c.carried_down ?? 0,
      lines,
      actual_up,
      actual_down,
      actual_used: actual_up + actual_down,
      used_up,
      used_down,
      used,
      state: customerState(c, used, now),
      next_reset_at: nextResetAt(c, now),
      sub_links: links.get(c.id) ?? [],
      upstreams: upstreams.get(c.id) ?? [],
    };
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
  return db.transaction(() => {
    const info = db
      .prepare('INSERT INTO customers (name, remark, quota_bytes, expire_at, reset_day, last_reset_at, sub_template, limit_devices, monthly_fee, traffic_ratio, sub_token, upstream_mode, upstream_userinfo, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(validName(input.name), String(input.remark ?? '').trim(), nonNegativeInt(input.quota_bytes, '额度'), nonNegativeInt(input.expire_at, '到期时间'), validResetDay(input.reset_day), now, validTemplate(input.sub_template), validLimitDevices(input.limit_devices), validCost(input.monthly_fee, '月费'), validRatio(input.traffic_ratio), newSubToken(), validUpstreamMode(input.upstream_mode), input.upstream_userinfo === true ? 1 : 0, now, now);
    const id = Number(info.lastInsertRowid);
    if (input.sub_links !== undefined) setCustomLinks(db, id, input.sub_links);
    if (input.upstreams !== undefined) setUpstreams(db, id, input.upstreams);
    return id;
  })();
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
  const expireAt = input.expire_at === undefined ? cur.expire_at : nonNegativeInt(input.expire_at, '到期时间');
  const update = db.prepare('UPDATE customers SET name = ?, remark = ?, quota_bytes = ?, expire_at = ?, reset_day = ?, last_reset_at = ?, sub_template = ?, limit_devices = ?, monthly_fee = ?, traffic_ratio = ?, upstream_mode = ?, upstream_userinfo = ?, updated_at = ? WHERE id = ?');
  const values = [
    input.name === undefined ? cur.name : validName(input.name),
    input.remark === undefined ? cur.remark : String(input.remark ?? '').trim(),
    input.quota_bytes === undefined ? cur.quota_bytes : nonNegativeInt(input.quota_bytes, '额度'),
    expireAt,
    resetDay,
    // 刚开 / 改了重置日,或者到期日变了(重置日跟着到期日走):从现在起算,下一个重置日才清,不会改完马上把这期清掉
    resetDay !== cur.reset_day || (resetDay > 0 && expireAt !== cur.expire_at) ? now : cur.last_reset_at,
    input.sub_template === undefined ? cur.sub_template : validTemplate(input.sub_template),
    input.limit_devices === undefined ? cur.limit_devices : validLimitDevices(input.limit_devices),
    input.monthly_fee === undefined ? cur.monthly_fee : validCost(input.monthly_fee, '月费'),
    input.traffic_ratio === undefined ? cur.traffic_ratio : validRatio(input.traffic_ratio),
    input.upstream_mode === undefined ? cur.upstream_mode : validUpstreamMode(input.upstream_mode),
    input.upstream_userinfo === undefined ? cur.upstream_userinfo : input.upstream_userinfo === true ? 1 : 0,
    now,
    id,
  ];
  db.transaction(() => {
    update.run(...values);
    if (input.sub_links !== undefined) setCustomLinks(db, id, input.sub_links);
    if (input.upstreams !== undefined) setUpstreams(db, id, input.upstreams);
  })();
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

/** 把 at 这个时刻挪到 year 年 month 月(0 起)的同一天同一时刻;那个月没有这一天(29-31 号)就取月末 */
function sameDayIn(at: Date, year: number, month: number): number {
  const last = new Date(year, month + 1, 0).getDate();
  return new Date(year, month, Math.min(at.getDate(), last), at.getHours(), at.getMinutes(), at.getSeconds(), at.getMilliseconds()).getTime();
}

/**
 * 这位客户本期的起点。有到期时间:重置跟着到期日走,起点是 now 之前最近的那个「到期时刻往前 / 往后推整月」
 * (15 号 23:59 到期,就是每月 15 号 23:59;续费后到期日变了,重置日跟着变)。没有到期时间:每月 reset_day 号 0 点。
 */
export function resetPeriodStart(c: { reset_day: number; expire_at: number }, now = Date.now()): number {
  if (!c.expire_at) return periodStart(c.reset_day, now);
  const at = new Date(c.expire_at);
  const d = new Date(now);
  const start = sameDayIn(at, d.getFullYear(), d.getMonth());
  return start > now ? sameDayIn(at, d.getFullYear(), d.getMonth() - 1) : start;
}

/** 下次按月重置的时间;没开返回 0 */
export function nextResetAt(c: { reset_day: number; expire_at: number }, now = Date.now()): number {
  if (!c.reset_day) return 0;
  const start = new Date(resetPeriodStart(c, now));
  if (!c.expire_at) return new Date(start.getFullYear(), start.getMonth() + 1, c.reset_day).getTime();
  return sameDayIn(new Date(c.expire_at), start.getFullYear(), start.getMonth() + 1);
}

/** 到了重置日还没清的客户 */
export function customersDueReset(db: DB, now = Date.now()): CustomerView[] {
  return listCustomers(db).filter((c) => c.reset_day > 0 && c.last_reset_at < resetPeriodStart(c, now));
}

/** 同步到的客户端状态写回线路(面板上没有这个客户端时 present = false,流量保持上次的值) */
export function updateLineStats(db: DB, lineId: number, s: { up: number; down: number; enable: boolean; last_online: number }, now = Date.now()): void {
  db.prepare('UPDATE lines SET up = ?, down = ?, enable = ?, last_online = ?, synced_at = ? WHERE id = ?').run(s.up, s.down, s.enable ? 1 : 0, s.last_online, now, lineId);
}

export function markLineAuto(db: DB, lineId: number, autoDisabled: boolean, enable: boolean): void {
  db.prepare('UPDATE lines SET auto_disabled = ?, enable = ? WHERE id = ?').run(autoDisabled ? 1 : 0, enable ? 1 : 0, lineId);
}

/** 在 xui-hub 里清零了这条线路(面板上已经清了):本地归零,记下时间,清零前读到的计数不再写回 */
export function zeroLineTraffic(db: DB, lineId: number, now = Date.now()): void {
  db.prepare('UPDATE lines SET up = 0, down = 0, zeroed_at = ? WHERE id = ?').run(now, lineId);
}

/** 把实际流量结转到客户身上(删线路、面板上的计数被清零时用);up / down 可以是负数(手动减) */
export function carryTraffic(db: DB, customerId: number, up: number, down: number): void {
  if (up || down) db.prepare('UPDATE customers SET carried_up = carried_up + ?, carried_down = carried_down + ? WHERE id = ?').run(up, down, customerId);
}

/** 清零时结转的也清掉,和线路计数一个口径 */
export function clearCarried(db: DB, customerId: number): void {
  db.prepare('UPDATE customers SET carried_up = 0, carried_down = 0 WHERE id = ?').run(customerId);
}

/**
 * 手动调整本期已用(实际流量,倍率另乘):加减 up / down 字节,记进结转。迁移时搬旧系统的用量、纠错时用,不用去改面板上的计数。
 * 调完的实际流量不能小于 0
 */
export function adjustUsage(db: DB, customerId: number, delta: { up?: unknown; down?: unknown }): void {
  const int = (v: unknown, label: string) => {
    if (v == null || v === '') return 0;
    const n = Number(v);
    if (!Number.isSafeInteger(n)) throw new InputError(`${label}要是整数(字节,可以是负数)`);
    return n;
  };
  const up = int(delta.up, '上行');
  const down = int(delta.down, '下行');
  if (!up && !down) throw new InputError('要调整多少?up / down 至少填一个不为 0 的数');
  const c = getCustomer(db, customerId);
  if (!c) throw new InputError('客户不存在');
  if (c.actual_up + up < 0 || c.actual_down + down < 0) throw new InputError('减多了:调整后的已用不能小于 0');
  carryTraffic(db, customerId, up, down);
}

export function linesOnPanel(db: DB, panelId: number): Line[] {
  return (db.prepare(`${LINE_SQL} WHERE l.panel_id = ? ORDER BY l.id`).all(panelId) as any[]).map(toLine);
}

/** 面板上这个 email 的 client 是不是某位客户的线路 */
export function lineByEmail(db: DB, panelId: number, email: string): Line | undefined {
  const row = db.prepare(`${LINE_SQL} WHERE l.panel_id = ? AND l.email = ?`).get(panelId, email);
  return row ? toLine(row) : undefined;
}

/** 出口是这个 SOCKS 的线路 */
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
  node_name?: string;
}

export function addLine(db: DB, l: LineInsert, now = Date.now()): Line {
  const info = db
    .prepare(
      `INSERT INTO lines (customer_id, kind, panel_id, inbound_id, inbound_remark, protocol, email, exit_kind, exit_panel_id, exit_port, exit_socks_id, exit_label, node_name, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(l.customer_id, l.kind, l.panel_id, l.inbound_id, l.inbound_remark, l.protocol, l.email, l.exit_kind ?? null, l.exit_panel_id ?? null, l.exit_port ?? null, l.exit_socks_id ?? null, l.exit_label ?? '', l.node_name ?? '', now);
  return getLine(db, Number(info.lastInsertRowid))!;
}

/** 改线路的自定义节点名(只改这里的记录,面板上不动) */
/** 线路的出口规则(已经写到面板上之后再存) */
export function setLineRules(db: DB, id: number, rules: LineRule[]): void {
  db.prepare('UPDATE lines SET rules = ? WHERE id = ?').run(JSON.stringify(rules), id);
}

/** 用到这个 SOCKS 的线路:出口是它,或出口规则里用了它 */
export function linesUsingSocks(db: DB, socksId: number): Line[] {
  return (
    db
      .prepare(
        `${LINE_SQL} WHERE l.exit_socks_id = ? OR EXISTS (SELECT 1 FROM json_each(l.rules) r WHERE json_extract(r.value, '$.to.socks_id') = ?) ORDER BY l.id`,
      )
      .all(socksId, socksId) as any[]
  ).map(toLine);
}

/** 同步时记下线路实际的出口 */
export function setLineRoutes(db: DB, id: number, routes: RouteHop[], now = Date.now()): void {
  db.prepare('UPDATE lines SET routes = ?, routes_at = ? WHERE id = ?').run(JSON.stringify(routes), now, id);
}

/** 换出口后改记录:给 SOCKS = 走它(relay);null = 直出(direct)。旧版本的「落地面板」出口一并清掉 */
export function setLineExit(db: DB, id: number, exit: { socks_id: number; label: string } | null): void {
  db.prepare('UPDATE lines SET kind = ?, exit_kind = ?, exit_panel_id = NULL, exit_port = NULL, exit_socks_id = ?, exit_label = ? WHERE id = ?').run(
    exit ? 'relay' : 'direct',
    exit ? 'socks' : null,
    exit?.socks_id ?? null,
    exit?.label ?? '',
    id,
  );
}

export function setLineName(db: DB, id: number, name: string): void {
  if (!db.prepare('UPDATE lines SET node_name = ? WHERE id = ?').run(name, id).changes) throw new InputError('线路不存在');
}

/** 删线路记录;它本期用掉的流量结转到客户身上,客户的已用不会因为删线路变少 */
export function deleteLine(db: DB, id: number): void {
  db.transaction(() => {
    const line = db.prepare('SELECT customer_id, up, down FROM lines WHERE id = ?').get(id) as { customer_id: number; up: number; down: number } | undefined;
    if (!line) throw new InputError('线路不存在');
    carryTraffic(db, line.customer_id, line.up ?? 0, line.down ?? 0);
    db.prepare('DELETE FROM lines WHERE id = ?').run(id);
  })();
}
