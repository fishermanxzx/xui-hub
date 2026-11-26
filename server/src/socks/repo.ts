// SOCKS 代理的存取(开线路时可选作出口)。账号密码只在服务端使用,对外视图不含密码。

import { nextId, type DB } from '../db';
import { InputError, setGeoLocation, validCost, validExpire, validLocation } from '../panels/repo';

export interface SocksEndpoint {
  host: string;
  port: number;
  username: string;
  password: string;
}

export interface SocksProxy extends SocksEndpoint {
  id: number;
  name: string;
  remark: string;
  /** 月成本,null = 没填 */
  monthly_cost: number | null;
  /** 到期时间(毫秒),0 = 没填 / 不限期 */
  expire_at: number;
  created_at: number;
  updated_at: number;
  /** 地理位置(SOCKS 页的地球,见 panels/geo.ts):坐标 null = 还没定位;geo_manual = 手动填的;geo_error = 没查到的原因 */
  geo_lat: number | null;
  geo_lng: number | null;
  geo_city: string;
  geo_country: string;
  geo_manual: boolean;
  geo_ip: string;
  geo_at: number;
  geo_error: string;
}

export interface SocksCheck {
  at: number;
  ok: boolean;
  ms: number;
  /** 出口 IP 与地区(Cloudflare trace) */
  ip: string | null;
  loc: string | null;
  error: string | null;
}

/** 用到这个 SOCKS 的一位客户:他名下有几条线路用到它 */
export interface SocksUser {
  id: number;
  name: string;
  lines: number;
}

/** used_by:用到它的线路数(出口是它,或出口规则里用了它);customers:这些线路属于几位客户;users:是哪几位(按名字排) */
export type SocksView = Omit<SocksProxy, 'password'> & { has_password: boolean; check: SocksCheck | null; used_by: number; customers: number; users: SocksUser[] };

export interface SocksInput {
  name?: unknown;
  /** 地址:socks5://用户:密码@主机:端口、用户:密码@主机:端口、主机:端口:用户:密码、主机:端口;修改时留空 = 不改 */
  address?: unknown;
  remark?: unknown;
  monthly_cost?: unknown;
  expire_at?: unknown;
  /** 位置:{ lat, lng, city? } = 手动填的坐标;null / 空 = 按出口 IP 自动查;不给 = 不改 */
  location?: unknown;
}

const decode = (v: string) => {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
};

/** 解析常见的 SOCKS 地址写法 */
export function parseSocksAddress(value: string): SocksEndpoint {
  let rest = value.trim();
  if (!rest) throw new InputError('地址不能为空');
  const scheme = rest.match(/^([a-z][a-z0-9+.-]*):\/\//i);
  if (scheme) {
    if (!/^socks5?h?$/i.test(scheme[1])) throw new InputError('只支持 socks5 代理');
    rest = rest.slice(scheme[0].length).replace(/\/+$/, '');
  }
  let host: string;
  let port: string;
  let username = '';
  let password = '';
  const at = rest.lastIndexOf('@');
  if (at >= 0) {
    // 用户:密码@主机:端口
    const auth = rest.slice(0, at);
    const colon = auth.indexOf(':');
    username = decode(colon >= 0 ? auth.slice(0, colon) : auth);
    password = decode(colon >= 0 ? auth.slice(colon + 1) : '');
    const m = rest.slice(at + 1).match(/^\[?([^\]\s]+?)\]?:(\d+)$/);
    if (!m) throw new InputError('地址格式不对,应为 主机:端口');
    [, host, port] = m;
  } else {
    // 主机:端口 或 主机:端口:用户:密码(密码里可以有冒号)
    const m = rest.match(/^([^:\s]+):(\d+)(?::([^:\s]*):(.*))?$/);
    if (!m) throw new InputError('地址格式不对,支持 socks5://用户:密码@主机:端口、主机:端口:用户:密码、主机:端口');
    [, host, port] = m;
    username = m[3] ?? '';
    password = m[4] ?? '';
  }
  const portNum = Number(port);
  if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) throw new InputError('端口须为 1-65535');
  if (password && !username) throw new InputError('有密码时必须有用户名');
  if (Buffer.byteLength(username) > 255 || Buffer.byteLength(password) > 255) throw new InputError('用户名和密码不能超过 255 字节');
  return { host: host.toLowerCase(), port: portNum, username, password };
}

function name(value: unknown): string {
  const v = String(value ?? '').trim();
  if (!v) throw new InputError('名称不能为空');
  if (v.length > 64) throw new InputError('名称不能超过 64 个字符');
  return v;
}

function rowToProxy(row: any): SocksProxy {
  return {
    id: row.id,
    name: row.name,
    host: row.host,
    port: row.port,
    username: row.username,
    password: row.password,
    remark: row.remark,
    monthly_cost: row.monthly_cost ?? null,
    expire_at: row.expire_at ?? 0,
    created_at: row.created_at,
    updated_at: row.updated_at,
    geo_lat: row.geo_lat ?? null,
    geo_lng: row.geo_lng ?? null,
    geo_city: row.geo_city ?? '',
    geo_country: row.geo_country ?? '',
    geo_manual: !!row.geo_manual,
    geo_ip: row.geo_ip ?? '',
    geo_at: row.geo_at ?? 0,
    geo_error: row.geo_error ?? '',
  };
}

function rowToView(row: any, users: SocksUser[]): SocksView {
  const { password, ...rest } = rowToProxy(row);
  return {
    ...rest,
    has_password: password !== '',
    used_by: row.used_by ?? 0,
    customers: row.customers ?? 0,
    users,
    check: row.check_at == null ? null : { at: row.check_at, ok: row.check_ok === 1, ms: row.check_ms, ip: row.check_ip, loc: row.check_loc, error: row.check_error },
  };
}

const USES = `l.exit_socks_id = s.id OR EXISTS (SELECT 1 FROM json_each(l.rules) r WHERE json_extract(r.value, '$.to.socks_id') = s.id)`;
const USING = `FROM lines l WHERE ${USES}`;
const VIEW_SQL = `SELECT s.*, (SELECT COUNT(*) ${USING}) AS used_by, (SELECT COUNT(DISTINCT l.customer_id) ${USING}) AS customers FROM socks_proxies s`;

/** 各 SOCKS 被哪些客户用着(socks id → 客户);只查一个时传 id */
function usersOf(db: DB, id?: number): Map<number, SocksUser[]> {
  const rows = db
    .prepare(
      `SELECT s.id AS sid, c.id, c.name, COUNT(*) AS lines FROM socks_proxies s JOIN lines l ON ${USES} JOIN customers c ON c.id = l.customer_id
       ${id == null ? '' : 'WHERE s.id = @id'} GROUP BY s.id, c.id ORDER BY c.name COLLATE NOCASE, c.id`,
    )
    .all(id == null ? {} : { id }) as (SocksUser & { sid: number })[];
  const out = new Map<number, SocksUser[]>();
  for (const { sid, ...u } of rows) {
    const list = out.get(sid);
    if (list) list.push(u);
    else out.set(sid, [u]);
  }
  return out;
}

export function listSocks(db: DB): SocksView[] {
  const users = usersOf(db);
  return (db.prepare(`${VIEW_SQL} ORDER BY s.name COLLATE NOCASE`).all() as any[]).map((row) => rowToView(row, users.get(row.id) ?? []));
}

export function getSocksView(db: DB, id: number): SocksView | undefined {
  const row = db.prepare(`${VIEW_SQL} WHERE s.id = ?`).get(id) as any;
  return row ? rowToView(row, usersOf(db, id).get(id) ?? []) : undefined;
}

/** 含密码,只在服务端使用(测连通性、给线路所在面板建出站) */
export function getSocks(db: DB, id: number): SocksProxy | undefined {
  const row = db.prepare('SELECT * FROM socks_proxies WHERE id = ?').get(id);
  return row ? rowToProxy(row) : undefined;
}

export function allSocks(db: DB): SocksProxy[] {
  return (db.prepare('SELECT * FROM socks_proxies ORDER BY id').all() as any[]).map(rowToProxy);
}

function assertNameFree(db: DB, value: string, exceptId = 0): void {
  if (db.prepare('SELECT 1 FROM socks_proxies WHERE name = ? AND id != ?').get(value, exceptId)) throw new InputError(`名称已存在:${value}`);
}

export function createSocks(db: DB, input: SocksInput, now = Date.now()): number {
  const n = name(input.name);
  assertNameFree(db, n);
  const ep = parseSocksAddress(String(input.address ?? ''));
  const values = [n, ep.host, ep.port, ep.username, ep.password, String(input.remark ?? '').trim(), validCost(input.monthly_cost), validExpire(input.expire_at), now, now] as const;
  const loc = validLocation(input.location);
  return db.transaction(() => {
    const id = nextId(db, 'socks_proxies');
    db.prepare('INSERT INTO socks_proxies (id, name, host, port, username, password, remark, monthly_cost, expire_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, ...values);
    if (loc) setGeoLocation(db, 'socks_proxies', id, loc);
    return id;
  })();
}

/**
 * 校验一次修改,算出要写的值,不落库。endpoint 非空 = 换了地址 / 账号:
 * 走它的线路要先在各自面板上跟着改(lines/open.ts 的 repointSocksLines),改成了再 updateSocks
 */
export function planSocksUpdate(
  db: DB,
  id: number,
  input: SocksInput,
): { cur: SocksProxy; name: string; remark: string; monthly_cost: number | null; expire_at: number; endpoint: SocksEndpoint | null; location: ReturnType<typeof validLocation> | undefined } {
  const cur = getSocks(db, id);
  if (!cur) throw new InputError('SOCKS 不存在');
  const n = input.name === undefined ? cur.name : name(input.name);
  assertNameFree(db, n, id);
  const address = String(input.address ?? '').trim();
  const ep = address ? parseSocksAddress(address) : null;
  const changed = ep && (ep.host !== cur.host || ep.port !== cur.port || ep.username !== cur.username || ep.password !== cur.password);
  return {
    cur,
    name: n,
    remark: input.remark === undefined ? cur.remark : String(input.remark ?? '').trim(),
    monthly_cost: input.monthly_cost === undefined ? cur.monthly_cost : validCost(input.monthly_cost),
    expire_at: input.expire_at === undefined ? cur.expire_at : validExpire(input.expire_at),
    endpoint: changed ? ep : null,
    location: input.location === undefined ? undefined : validLocation(input.location),
  };
}

export function updateSocks(db: DB, id: number, input: SocksInput, now = Date.now()): void {
  const plan = planSocksUpdate(db, id, input);
  const ep = plan.endpoint ?? plan.cur;
  db.prepare(
    `UPDATE socks_proxies SET name = ?, host = ?, port = ?, username = ?, password = ?, remark = ?, monthly_cost = ?, expire_at = ?, updated_at = ?
     ${plan.endpoint ? ', check_at = NULL, check_ok = NULL, check_ms = NULL, check_ip = NULL, check_loc = NULL, check_error = NULL' : ''}
     WHERE id = ?`,
  ).run(plan.name, ep.host, ep.port, ep.username, ep.password, plan.remark, plan.monthly_cost, plan.expire_at, now, id);
  if (plan.location !== undefined) setGeoLocation(db, 'socks_proxies', id, plan.location);
}

/** 还有线路拿它当出口时不让删(删了那些线路所在面板上的出站还指着它,记录却对不上了) */
export function deleteSocks(db: DB, id: number): void {
  const used = getSocksView(db, id)?.used_by ?? 0;
  if (used) throw new InputError(`还有 ${used} 条线路在用这个 SOCKS,先删掉这些线路`);
  if (db.prepare('DELETE FROM socks_proxies WHERE id = ?').run(id).changes === 0) throw new InputError('SOCKS 不存在');
}

export function saveCheck(db: DB, id: number, c: SocksCheck): void {
  db.prepare('UPDATE socks_proxies SET check_at = ?, check_ok = ?, check_ms = ?, check_ip = ?, check_loc = ?, check_error = ? WHERE id = ?').run(
    c.at,
    c.ok ? 1 : 0,
    c.ms,
    c.ip,
    c.loc,
    c.error,
    id,
  );
}
