// 自定义订阅链接:给客户另配的访问地址(路径,可带参数),访问它和访问生成的 /sub/<token> 完全一样。
// 用途不限:沿用别的系统发出去的旧链接、给客户一个好记的地址等。只认路径和参数,不认域名(那个域名要指到本服务)。
// 匹配:路径不分大小写、忽略末尾的 /;链接里写的参数请求里都要有且相等,请求多带的参数(如 ?target=clash)不影响。
// 同一路径配了几条时,取参数对得上且参数最多的那条。

import type { DB } from '../db';
import { InputError } from '../panels/repo';

/** 每位客户最多几条 */
export const MAX_LINKS = 20;
const MAX_LEN = 512;

/** 本程序自己用的地址,不能拿来当自定义链接 */
const RESERVED = ['/api', '/internal', '/mcp', '/oauth', '/.well-known', '/assets'];

function decode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** 路径规范化:解码、小写、去掉末尾的 / */
export function normPath(raw: string): string {
  return decode(raw).toLowerCase().replace(/\/+$/, '') || '/';
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** 参数规范化:按名字、值排序后重新编码;空串 = 不带参数 */
function normQuery(params: URLSearchParams): string {
  return [...params]
    .sort(([a, x], [b, y]) => cmp(a, b) || cmp(x, y))
    .map(([k, v]) => new URLSearchParams([[k, v]]).toString())
    .join('&');
}

export function isReserved(path: string): boolean {
  return path === '/' || path === '/index.html' || RESERVED.some((r) => path === r || path.startsWith(`${r}/`));
}

export interface ParsedLink {
  /** 显示用:路径 + 参数 */
  link: string;
  /** 匹配用:规范化后的路径和参数 */
  path: string;
  query: string;
}

/** 后台填的内容 → 链接。可以贴完整网址(只取路径和参数),也可以只填路径 */
export function parseCustomLink(raw: unknown): ParsedLink {
  const s = String(raw ?? '').trim();
  if (!s) throw new InputError('自定义链接不能为空');
  if (s.length > MAX_LEN) throw new InputError(`自定义链接不能超过 ${MAX_LEN} 个字符`);
  let u: URL;
  try {
    // 只填路径的:开头补成一个 /(两个 / 开头会被当成域名)
    u = /^https?:\/\//i.test(s) ? new URL(s) : new URL(s.replace(/^\/*/, '/'), 'http://x');
  } catch {
    throw new InputError(`自定义链接格式不对:${s}`);
  }
  const path = normPath(u.pathname);
  if (isReserved(path)) throw new InputError(`${u.pathname} 是本程序自己用的地址,不能当自定义链接`);
  return { link: u.pathname + u.search, path, query: normQuery(u.searchParams) };
}

/** 每位客户的自定义链接(显示用的样子,按添加顺序) */
export function customLinksByCustomer(db: DB, customerId?: number): Map<number, string[]> {
  const rows = (customerId == null ? db.prepare('SELECT customer_id, link FROM sub_links ORDER BY id').all() : db.prepare('SELECT customer_id, link FROM sub_links WHERE customer_id = ? ORDER BY id').all(customerId)) as {
    customer_id: number;
    link: string;
  }[];
  const out = new Map<number, string[]>();
  for (const r of rows) out.set(r.customer_id, [...(out.get(r.customer_id) ?? []), r.link]);
  return out;
}

/** 整组替换某位客户的自定义链接。input 是地址数组(或按行分隔的字符串),空的忽略、重复的合并 */
export function setCustomLinks(db: DB, customerId: number, input: unknown): void {
  const list = Array.isArray(input) ? input : typeof input === 'string' ? input.split(/\r?\n/) : null;
  if (!list) throw new InputError('自定义链接要是一组地址');
  const parsed = new Map<string, ParsedLink>();
  for (const raw of list) {
    if (!String(raw ?? '').trim()) continue;
    const p = parseCustomLink(raw);
    if (!parsed.has(`${p.path}?${p.query}`)) parsed.set(`${p.path}?${p.query}`, p);
  }
  if (parsed.size > MAX_LINKS) throw new InputError(`每位客户最多 ${MAX_LINKS} 个自定义链接`);
  db.transaction(() => {
    db.prepare('DELETE FROM sub_links WHERE customer_id = ?').run(customerId);
    const taken = db.prepare('SELECT c.name FROM sub_links s JOIN customers c ON c.id = s.customer_id WHERE s.path = ? AND s.query = ?');
    const tokenOwner = db.prepare('SELECT name FROM customers WHERE lower(sub_token) = ? AND id != ?');
    const insert = db.prepare('INSERT INTO sub_links (customer_id, link, path, query) VALUES (?, ?, ?, ?)');
    for (const p of parsed.values()) {
      const other = taken.get(p.path, p.query) as { name: string } | undefined;
      if (other) throw new InputError(`自定义链接 ${p.link} 已经配给了客户「${other.name}」`);
      // 自定义链接优先于 /sub/<token>:不能占掉别的客户生成的链接
      const owner = p.path.startsWith('/sub/') ? (tokenOwner.get(p.path.slice(5), customerId) as { name: string } | undefined) : undefined;
      if (owner) throw new InputError(`自定义链接 ${p.link} 和客户「${owner.name}」的订阅链接重了`);
      insert.run(customerId, p.link, p.path, p.query);
    }
  })();
}

/**
 * 请求的路径和参数(原样,未解码)对上哪位客户的自定义链接。
 * undefined = 这个路径没配过(交给别的路由);null = 路径配过但参数对不上(按找不到订阅处理)
 */
export function customerIdByLink(db: DB, rawPath: string, rawQuery: string): number | null | undefined {
  const path = normPath(rawPath);
  if (isReserved(path)) return undefined;
  const rows = db.prepare('SELECT customer_id, query FROM sub_links WHERE path = ? ORDER BY id').all(path) as { customer_id: number; query: string }[];
  if (!rows.length) return undefined;
  const got = new URLSearchParams(rawQuery);
  let best: number | null = null;
  let most = -1;
  for (const r of rows) {
    const want = [...new URLSearchParams(r.query)];
    if (want.length > most && want.every(([k, v]) => got.getAll(k).includes(v))) {
      best = r.customer_id;
      most = want.length;
    }
  }
  return best;
}
