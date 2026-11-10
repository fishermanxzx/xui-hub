// SOCKS 代理的存取(中转的出口之一)。账号密码只在服务端使用,对外视图不含密码。

import type { DB } from '../db';
import { InputError } from '../panels/repo';

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
  created_at: number;
  updated_at: number;
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

/** used_by:出口是它的中转线路数 */
export type SocksView = Omit<SocksProxy, 'password'> & { has_password: boolean; check: SocksCheck | null; used_by: number };

export interface SocksInput {
  name?: unknown;
  /** 地址:socks5://用户:密码@主机:端口、用户:密码@主机:端口、主机:端口:用户:密码、主机:端口;修改时留空 = 不改 */
  address?: unknown;
  remark?: unknown;
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
  return { id: row.id, name: row.name, host: row.host, port: row.port, username: row.username, password: row.password, remark: row.remark, created_at: row.created_at, updated_at: row.updated_at };
}

function rowToView(row: any): SocksView {
  const { password, ...rest } = rowToProxy(row);
  return {
    ...rest,
    has_password: password !== '',
    used_by: row.used_by ?? 0,
    check: row.check_at == null ? null : { at: row.check_at, ok: row.check_ok === 1, ms: row.check_ms, ip: row.check_ip, loc: row.check_loc, error: row.check_error },
  };
}

const VIEW_SQL = 'SELECT s.*, (SELECT COUNT(*) FROM lines l WHERE l.exit_socks_id = s.id) AS used_by FROM socks_proxies s';

export function listSocks(db: DB): SocksView[] {
  return (db.prepare(`${VIEW_SQL} ORDER BY s.name COLLATE NOCASE`).all() as any[]).map(rowToView);
}

export function getSocksView(db: DB, id: number): SocksView | undefined {
  const row = db.prepare(`${VIEW_SQL} WHERE s.id = ?`).get(id);
  return row ? rowToView(row) : undefined;
}

/** 含密码,只在服务端使用(测连通性、给中转建出站) */
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
  const info = db
    .prepare('INSERT INTO socks_proxies (name, host, port, username, password, remark, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(n, ep.host, ep.port, ep.username, ep.password, String(input.remark ?? '').trim(), now, now);
  return Number(info.lastInsertRowid);
}

/**
 * 校验一次修改,算出要写的值,不落库。endpoint 非空 = 换了地址 / 账号:
 * 在用它的中转要先跟着改(lines/open.ts 的 repointSocksLines),改成了再 updateSocks
 */
export function planSocksUpdate(db: DB, id: number, input: SocksInput): { cur: SocksProxy; name: string; remark: string; endpoint: SocksEndpoint | null } {
  const cur = getSocks(db, id);
  if (!cur) throw new InputError('SOCKS 不存在');
  const n = input.name === undefined ? cur.name : name(input.name);
  assertNameFree(db, n, id);
  const address = String(input.address ?? '').trim();
  const ep = address ? parseSocksAddress(address) : null;
  const changed = ep && (ep.host !== cur.host || ep.port !== cur.port || ep.username !== cur.username || ep.password !== cur.password);
  return { cur, name: n, remark: input.remark === undefined ? cur.remark : String(input.remark ?? '').trim(), endpoint: changed ? ep : null };
}

export function updateSocks(db: DB, id: number, input: SocksInput, now = Date.now()): void {
  const plan = planSocksUpdate(db, id, input);
  const ep = plan.endpoint ?? plan.cur;
  db.prepare(
    `UPDATE socks_proxies SET name = ?, host = ?, port = ?, username = ?, password = ?, remark = ?, updated_at = ?
     ${plan.endpoint ? ', check_at = NULL, check_ok = NULL, check_ms = NULL, check_ip = NULL, check_loc = NULL, check_error = NULL' : ''}
     WHERE id = ?`,
  ).run(plan.name, ep.host, ep.port, ep.username, ep.password, plan.remark, now, id);
}

/** 还有线路拿它当出口时不让删(删了那些线路在中转上的出站还指着它,记录却对不上了) */
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
