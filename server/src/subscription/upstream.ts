// 外部订阅:给客户配上别处的订阅地址(比如出口代理商给的),客户拉我们的订阅时把那边的节点一起给出去,
// 或者只给那边的(upstream_mode = replace)。客户手里的订阅链接不用换。
// - 那边的内容可以是节点链接(明文 / base64)、Clash 配置或 sing-box 配置,解析见 upstreamParse.ts;
//   解析成节点链接后和客户自己线路的节点走同一套输出,所以每种订阅格式都支持。
// - 每次取到就存下来:那边取不到时用上次成功的结果,客户端不会被一份空订阅冲掉。
// - 60 秒内取过就不再重复取(Clash 等格式一次请求里要用两回)。
// - 客户停用 / 到期时和自己的线路一样不出节点,也不去拉。
// - 只取那边的节点:Clash / sing-box 配置里的分组、规则一概不要,输出用的是本系统的模板和配置;
//   节点名可以按每个外部订阅改(node_name,见 nodeName.ts 的 renameByTemplate)。

import type { DB } from '../db';
import { InputError } from '../panels/repo';
import { linkName, renameByTemplate, validNodeName } from './nodeName';
import { parseUpstreamBody } from './upstreamParse';

export const MAX_UPSTREAMS = 10;
const MAX_URL_LEN = 2048;
const MAX_BODY = 5 * 1024 * 1024;
const TIMEOUT_MS = 10_000;
/** 这么久内取过(不管成没成功)就用上次的结果 */
export const FRESH_MS = 60_000;
/** 按 v2rayN 去拉:多数面板给它节点链接(base64),解析起来最完整 */
export const UPSTREAM_UA = 'v2rayN/7.10.5';
/**
 * 本程序去拉外部订阅时带的头。收到带这个头的订阅请求只给自己线路的节点,不再往外拉:
 * 外部订阅配成了本服务自己的链接,或者两边互相配成对方的外部订阅时,不会绕圈
 */
export const HOP_HEADER = 'X-Xui-Hub-Upstream';

export type UpstreamMode = 'merge' | 'replace';

/** subscription-userinfo:upload / download / total 是字节,expire 是秒,0 = 不限 */
export interface Userinfo {
  upload: number;
  download: number;
  total: number;
  expire: number;
}

export interface UpstreamView {
  id: number;
  url: string;
  /** 节点名:空 = 用对方的;可带 {name} / {n} */
  node_name: string;
  /** 订阅里的节点名(改名之后的,最多列 100 个) */
  names: string[];
  /** 上次成功取到的节点数(取不到时照常用这些) */
  nodes: number;
  /** 认不出协议、没出的节点数 */
  skipped: number;
  /** 那边给的流量和到期 */
  userinfo: Userinfo | null;
  /** 上次成功 / 上次尝试的时间(毫秒),0 = 还没有过 */
  ok_at: number;
  tried_at: number;
  /** 上次尝试失败的原因,成功了为空 */
  error: string;
}

export function validUpstreamMode(value: unknown): UpstreamMode {
  if (value == null || value === '' || value === 'merge') return 'merge';
  if (value === 'replace') return 'replace';
  throw new InputError('upstream_mode 只能是 merge(和自己线路的节点一起给)或 replace(只给外部订阅的节点)');
}

export interface UpstreamInput {
  url: string;
  /** undefined = 不改(已有的保留原来的,新加的为空) */
  node_name?: string;
}

/**
 * 后台填的外部订阅:数组(每项是地址,或 { url, node_name })或按行分隔的地址;去重,保持顺序
 */
export function validUpstreams(raw: unknown): UpstreamInput[] {
  const list = Array.isArray(raw) ? raw : String(raw ?? '').split(/\r?\n/);
  const out: UpstreamInput[] = [];
  for (const item of list) {
    const obj = item && typeof item === 'object' ? (item as Record<string, unknown>) : null;
    const s = String((obj ? obj.url : item) ?? '').trim();
    if (!s) continue;
    if (s.length > MAX_URL_LEN) throw new InputError(`外部订阅地址不能超过 ${MAX_URL_LEN} 个字符`);
    let url: URL | undefined;
    try {
      url = new URL(s);
    } catch {
      url = undefined;
    }
    if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:')) throw new InputError('外部订阅要填完整地址,以 http:// 或 https:// 开头');
    if (out.some((u) => u.url === s)) continue;
    out.push({ url: s, node_name: obj && obj.node_name !== undefined ? validNodeName(obj.node_name) : undefined });
  }
  if (out.length > MAX_UPSTREAMS) throw new InputError(`外部订阅每位客户最多 ${MAX_UPSTREAMS} 个`);
  return out;
}

/** 整组替换;地址没变的保留上次取到的结果,没给节点名的保留原来的节点名 */
export function setUpstreams(db: DB, customerId: number, raw: unknown): void {
  const list = validUpstreams(raw);
  const current = db.prepare('SELECT id, url FROM upstream_subs WHERE customer_id = ?').all(customerId) as { id: number; url: string }[];
  const del = db.prepare('DELETE FROM upstream_subs WHERE id = ?');
  for (const row of current) if (!list.some((u) => u.url === row.url)) del.run(row.id);
  const insert = db.prepare('INSERT INTO upstream_subs (customer_id, url, node_name, position) VALUES (?, ?, ?, ?)');
  const move = db.prepare('UPDATE upstream_subs SET position = ?, node_name = COALESCE(?, node_name) WHERE id = ?');
  list.forEach((u, i) => {
    const row = current.find((r) => r.url === u.url);
    if (row) move.run(i, u.node_name ?? null, row.id);
    else insert.run(customerId, u.url, u.node_name ?? '', i);
  });
}

function storedLinks(json: string): string[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * 存着的节点链接按这个外部订阅的节点名改好。结果按库缓存:读客户(每轮检查、每个修改请求)要列名字,拉订阅要用链接,
 * 一个外部订阅最多 5 MB,不必每次都整个重新解析、改名。内容变了(重新取到、换了节点名)键就变了
 */
const renamedCache = new WeakMap<DB, Map<string, string[]>>();
function renamedLinks(db: DB, r: { id: number; ok_at: number; links: string; node_name: string }): string[] {
  let cache = renamedCache.get(db);
  if (!cache) renamedCache.set(db, (cache = new Map()));
  const key = `${r.id}|${r.ok_at}|${r.node_name}|${r.links.length}|${r.links.slice(0, 200)}|${r.links.slice(-200)}`;
  let links = cache.get(key);
  if (!links) {
    links = renameByTemplate(storedLinks(r.links), r.node_name);
    cache.set(key, links);
    // 只留最近用到的一些
    if (cache.size > 200) cache.delete(cache.keys().next().value!);
  }
  return links;
}

export function parseUserinfo(header: string | null | undefined): Userinfo | null {
  if (!header) return null;
  const v: Record<string, number> = {};
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim().toLowerCase();
    const n = Number(part.slice(eq + 1).trim());
    if (key && Number.isFinite(n) && n >= 0) v[key] = Math.floor(n);
  }
  if (!['upload', 'download', 'total', 'expire'].some((k) => k in v)) return null;
  return { upload: v.upload ?? 0, download: v.download ?? 0, total: v.total ?? 0, expire: v.expire ?? 0 };
}

/** 几个外部订阅的流量加起来;总量有一个不限就算不限,到期取最早的 */
export function sumUserinfo(list: (Userinfo | null)[]): Userinfo | null {
  const xs = list.filter((x): x is Userinfo => !!x);
  if (!xs.length) return null;
  const expires = xs.map((x) => x.expire).filter((e) => e > 0);
  return {
    upload: xs.reduce((s, x) => s + x.upload, 0),
    download: xs.reduce((s, x) => s + x.download, 0),
    total: xs.some((x) => x.total === 0) ? 0 : xs.reduce((s, x) => s + x.total, 0),
    expire: expires.length ? Math.min(...expires) : 0,
  };
}

export const userinfoText = (u: Userinfo) => `upload=${u.upload}; download=${u.download}; total=${u.total}; expire=${u.expire}`;

const toView = (db: DB, r: any): UpstreamView => ({
  id: r.id,
  url: r.url,
  node_name: r.node_name,
  names: renamedLinks(db, r).slice(0, 100).map(linkName),
  nodes: r.nodes,
  skipped: r.skipped,
  userinfo: parseUserinfo(r.userinfo),
  ok_at: r.ok_at,
  tried_at: r.tried_at,
  error: r.error,
});

export function upstreamsByCustomer(db: DB, customerId?: number): Map<number, UpstreamView[]> {
  const cols = 'id, customer_id, url, node_name, links, nodes, skipped, userinfo, ok_at, tried_at, error';
  const rows = (customerId === undefined
    ? db.prepare(`SELECT ${cols} FROM upstream_subs ORDER BY customer_id, position, id`).all()
    : db.prepare(`SELECT ${cols} FROM upstream_subs WHERE customer_id = ? ORDER BY position, id`).all(customerId)) as any[];
  const out = new Map<number, UpstreamView[]>();
  for (const r of rows) out.set(r.customer_id, [...(out.get(r.customer_id) ?? []), toView(db, r)]);
  return out;
}

/** 存着的结果:节点链接(按顺序、改好名字)、一次都没取到过的个数、流量 */
export function cachedUpstream(db: DB, customerId: number): { links: string[]; total: number; failed: number; userinfo: Userinfo | null } {
  const rows = db.prepare('SELECT id, ok_at, links, node_name, userinfo FROM upstream_subs WHERE customer_id = ? ORDER BY position, id').all(customerId) as { id: number; ok_at: number; links: string; node_name: string; userinfo: string }[];
  const lists = rows.map((r) => renamedLinks(db, r));
  return { links: lists.flat(), total: rows.length, failed: lists.filter((l) => !l.length).length, userinfo: sumUserinfo(rows.map((r) => parseUserinfo(r.userinfo))) };
}

export type UpstreamFetcher = (url: string) => Promise<{ status: number; body: string; userinfo: string | null }>;

/** 最多读 maxBytes,超过就放弃 */
async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error(`内容超过 ${maxBytes / 1024 / 1024} MB`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export const fetchUpstream: UpstreamFetcher = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'follow', headers: { 'User-Agent': UPSTREAM_UA, Accept: '*/*', [HOP_HEADER]: '1' } });
  return { status: res.status, body: await readCapped(res, MAX_BODY), userinfo: res.headers.get('subscription-userinfo') };
};

function errorText(e: unknown): string {
  if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')) return `${TIMEOUT_MS / 1000} 秒内没取到(超时)`;
  const cause = e instanceof Error ? (e.cause as { code?: string; message?: string } | undefined) : undefined;
  const msg = e instanceof Error ? e.message : String(e);
  return (cause ? `${msg}(${cause.code ?? cause.message})` : msg).slice(0, 300);
}

/** 正在取的:同一个地址同时只取一次,后来的等同一个结果 */
const inflight = new Map<number, Promise<void>>();

function refreshOne(db: DB, id: number, url: string, fetcher: UpstreamFetcher): Promise<void> {
  let p = inflight.get(id);
  if (p) return p;
  p = (async () => {
    const at = Date.now();
    try {
      const got = await fetcher(url);
      if (got.status < 200 || got.status >= 300) throw new Error(`返回 HTTP ${got.status}`);
      const parsed = parseUpstreamBody(got.body);
      if (!parsed.links.length) {
        throw new Error(parsed.skipped ? `${parsed.skipped} 个节点的协议都不支持` : '内容里没有节点(认得的是节点链接、Clash 配置、sing-box 配置)');
      }
      db.prepare("UPDATE upstream_subs SET links = ?, nodes = ?, skipped = ?, userinfo = ?, ok_at = ?, tried_at = ?, error = '' WHERE id = ?").run(
        JSON.stringify(parsed.links),
        parsed.links.length,
        parsed.skipped,
        got.userinfo ?? '',
        at,
        at,
        id,
      );
    } catch (e) {
      // 取不到:留着上次成功的结果接着用
      db.prepare('UPDATE upstream_subs SET tried_at = ?, error = ? WHERE id = ?').run(at, errorText(e), id);
    }
  })().finally(() => inflight.delete(id));
  inflight.set(id, p);
  return p;
}

/**
 * 去取这位客户的外部订阅。force = 不管多久前取过都重新取;否则 60 秒内取过的不取。
 * 取不到的不报错,原因记在 error 里
 */
export async function refreshUpstreams(db: DB, customerId: number, fetcher: UpstreamFetcher, opts: { force?: boolean; onlyNew?: boolean } = {}): Promise<void> {
  const rows = db.prepare('SELECT id, url, tried_at FROM upstream_subs WHERE customer_id = ?').all(customerId) as { id: number; url: string; tried_at: number }[];
  const now = Date.now();
  const due = rows.filter((r) => (opts.onlyNew ? r.tried_at === 0 : opts.force || now - r.tried_at >= FRESH_MS));
  await Promise.all(due.map((r) => refreshOne(db, r.id, r.url, fetcher)));
}
