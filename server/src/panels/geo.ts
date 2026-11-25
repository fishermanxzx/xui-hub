// 面板 / SOCKS 的地理位置,给面板页、SOCKS 页的地球用:按 IP 查公开的 IP 库(先 ipwho.is,查不到再试 ipinfo.io)。
// 面板按面板地址解析出的 IP;SOCKS 按测出来的出口 IP(流量从哪出去)。
// - 只在打开地球(GET /panels/geo、/socks/geo)时才查,不打开就一次都不查;
// - 查过的 IP 存下来不重查,面板 IP 变了再查;没查到的 1 小时内不重试;
// - 手动填了坐标的不查(IP 库对一些机房 IP 不准,比如注册在美国、机器在香港)。

import { isIP } from 'node:net';
import { fetch } from 'undici';
import type { DB } from '../db';
import { listSocks } from '../socks/repo';
import { listPanels, type Panel } from './repo';

export interface GeoResult {
  lat: number;
  lng: number;
  city: string;
  /** 两位国家代码,如 US */
  country: string;
}
export type GeoLookup = (ip: string) => Promise<GeoResult>;

const TIMEOUT_MS = 6000;
/** 没查到的,隔这么久再试 */
export const GEO_RETRY_MS = 3600_000;
/** 一次最多查这么久,剩下的下次打开再查(不让页面一直等) */
const BUDGET_MS = 15_000;
const CONCURRENCY = 4;

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : NaN);

async function getJson(url: string): Promise<any> {
  const res = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'xui-hub' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

const providers: { name: string; get: (ip: string) => Promise<GeoResult> }[] = [
  {
    name: 'ipwho.is',
    get: async (ip) => {
      const d = await getJson(`https://ipwho.is/${encodeURIComponent(ip)}?fields=success,message,latitude,longitude,city,country_code`);
      if (d?.success === false) throw new Error(String(d.message || '查不到'));
      return { lat: num(d?.latitude), lng: num(d?.longitude), city: String(d?.city ?? ''), country: String(d?.country_code ?? '') };
    },
  },
  {
    name: 'ipinfo.io',
    get: async (ip) => {
      const d = await getJson(`https://ipinfo.io/${encodeURIComponent(ip)}/json`);
      if (d?.bogon) throw new Error('内网 / 保留地址');
      const [lat, lng] = String(d?.loc ?? '').split(',').map(num);
      return { lat, lng, city: String(d?.city ?? ''), country: String(d?.country ?? '') };
    },
  },
];

/** 依次试各家,第一个给出有效坐标的算数;都不行就把各家的原因拼起来抛出 */
export const lookupGeo: GeoLookup = async (ip) => {
  const errors: string[] = [];
  for (const p of providers) {
    try {
      const r = await p.get(ip);
      if (Number.isFinite(r.lat) && Number.isFinite(r.lng) && Math.abs(r.lat) <= 90 && Math.abs(r.lng) <= 180) return { ...r, city: r.city.slice(0, 60), country: r.country.slice(0, 2).toUpperCase() };
      errors.push(`${p.name}:没有坐标`);
    } catch (e) {
      errors.push(`${p.name}:${e instanceof Error ? e.message : String(e)}`);
    }
  }
  throw new Error(errors.join(';'));
};

/** 按哪个 IP 查:检查时解析出的 IP;还没有就看地址本身是不是 IP;都没有 = null */
export function geoIpOf(p: Pick<Panel, 'ip' | 'base_url'>): string | null {
  if (p.ip) return p.ip;
  try {
    const host = new URL(p.base_url).hostname.replace(/^\[|\]$/g, '');
    return isIP(host) ? host : null;
  } catch {
    return null;
  }
}

type GeoTable = 'panels' | 'socks_proxies';
const NO_IP: Record<GeoTable, string> = { panels: '还没解析出 IP,检查一次面板后再看', socks_proxies: '还没测出出口 IP,点「测试」后再看' };

/** 一行要定位的东西:按哪个 IP 查(null = 没有可查的)+ 现在存着的位置 */
interface GeoRow {
  id: number;
  ip: string | null;
  geo_lat: number | null;
  geo_ip: string;
  geo_manual: boolean;
  geo_at: number;
  geo_error: string;
}

/** 要不要(重新)查:手动填的不查;IP 变了查;同一个 IP 查到过不查,没查到的过了重试间隔再查 */
function due(r: GeoRow, ip: string, now: number): boolean {
  if (r.geo_manual) return false;
  if (r.geo_ip !== ip) return true;
  return r.geo_lat == null && now - r.geo_at >= GEO_RETRY_MS;
}

const running = new WeakMap<DB, Map<GeoTable, Promise<void>>>();

/** 同一个库、同一张表同时只跑一轮(两个页面一起打开也只查一次) */
function once(db: DB, table: GeoTable, fn: () => Promise<void>): Promise<void> {
  let byTable = running.get(db);
  if (!byTable) running.set(db, (byTable = new Map()));
  let p = byTable.get(table);
  if (!p) {
    p = fn().finally(() => byTable!.delete(table));
    byTable.set(table, p);
  }
  return p;
}

/** 把该查的面板查一遍 */
export function refreshPanelGeo(db: DB, lookup: GeoLookup = lookupGeo, now = Date.now()): Promise<void> {
  return once(db, 'panels', () => run(db, 'panels', listPanels(db).map((p) => ({ ...p, ip: geoIpOf(p) })), lookup, now));
}

/**
 * 把该查的 SOCKS 查一遍:按测出来的出口 IP(流量从哪出去);还没测过、也还没定位的,地址是 IP 就先按地址查。
 * 测试失败时出口 IP 是空的,已经定位过的就留着原来的位置
 */
export function refreshSocksGeo(db: DB, lookup: GeoLookup = lookupGeo, now = Date.now()): Promise<void> {
  const hostIp = (host: string) => (isIP(host.replace(/^\[|\]$/g, '')) ? host.replace(/^\[|\]$/g, '') : null);
  return once(db, 'socks_proxies', () => run(db, 'socks_proxies', listSocks(db).map((s) => ({ ...s, ip: s.check?.ip || (s.geo_lat == null ? hostIp(s.host) : null) })), lookup, now));
}

async function run(db: DB, table: GeoTable, rows: GeoRow[], lookup: GeoLookup, now: number): Promise<void> {
  const save = db.prepare(`UPDATE ${table} SET geo_lat = ?, geo_lng = ?, geo_city = ?, geo_country = ?, geo_ip = ?, geo_at = ?, geo_error = '' WHERE id = ? AND geo_manual = 0`);
  const fail = db.prepare(`UPDATE ${table} SET geo_lat = NULL, geo_lng = NULL, geo_city = '', geo_country = '', geo_ip = ?, geo_at = ?, geo_error = ? WHERE id = ? AND geo_manual = 0`);
  const noIp = db.prepare(`UPDATE ${table} SET geo_error = ? WHERE id = ? AND geo_manual = 0 AND geo_lat IS NULL`);
  const todo: { id: number; ip: string }[] = [];
  for (const r of rows) {
    if (r.geo_manual) continue;
    if (!r.ip) {
      if (r.geo_lat == null && r.geo_error !== NO_IP[table]) noIp.run(NO_IP[table], r.id);
      continue;
    }
    if (due(r, r.ip, now)) todo.push({ id: r.id, ip: r.ip });
  }
  const start = Date.now();
  // 同一个 IP 的几行只查一次
  const cache = new Map<string, Promise<GeoResult>>();
  const worker = async () => {
    for (let job = todo.shift(); job; job = todo.shift()) {
      if (Date.now() - start > BUDGET_MS) return;
      if (!cache.has(job.ip)) cache.set(job.ip, lookup(job.ip));
      try {
        const r = await cache.get(job.ip)!;
        save.run(r.lat, r.lng, r.city, r.country, job.ip, now, job.id);
      } catch (e) {
        fail.run(job.ip, now, (e instanceof Error ? e.message : String(e)).slice(0, 300), job.id);
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
}
