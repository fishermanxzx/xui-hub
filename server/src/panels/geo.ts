// 面板的地理位置,给面板页的地球用:按面板的 IP 查公开的 IP 库(先 ipwho.is,查不到再试 ipinfo.io)。
// - 只在打开地球(GET /panels/geo)时才查,不打开就一次都不查;
// - 查过的 IP 存下来不重查,面板 IP 变了再查;没查到的 1 小时内不重试;
// - 手动填了坐标的面板不查(IP 库对一些机房 IP 不准,比如注册在美国、机器在香港)。

import { isIP } from 'node:net';
import { fetch } from 'undici';
import type { DB } from '../db';
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

const NO_IP = '还没解析出 IP,检查一次面板后再看';

/** 要不要(重新)查:手动填的不查;IP 变了查;同一个 IP 查到过不查,没查到的过了重试间隔再查 */
function due(p: Panel, ip: string, now: number): boolean {
  if (p.geo_manual) return false;
  if (p.geo_ip !== ip) return true;
  return p.geo_lat == null && now - p.geo_at >= GEO_RETRY_MS;
}

const running = new WeakMap<DB, Promise<void>>();

/** 把该查的面板查一遍(同一个库同时只跑一轮,两个页面一起打开也只查一次) */
export function refreshPanelGeo(db: DB, lookup: GeoLookup = lookupGeo, now = Date.now()): Promise<void> {
  let p = running.get(db);
  if (!p) {
    p = run(db, lookup, now).finally(() => running.delete(db));
    running.set(db, p);
  }
  return p;
}

async function run(db: DB, lookup: GeoLookup, now: number): Promise<void> {
  const save = db.prepare("UPDATE panels SET geo_lat = ?, geo_lng = ?, geo_city = ?, geo_country = ?, geo_ip = ?, geo_at = ?, geo_error = '' WHERE id = ? AND geo_manual = 0");
  const fail = db.prepare("UPDATE panels SET geo_lat = NULL, geo_lng = NULL, geo_city = '', geo_country = '', geo_ip = ?, geo_at = ?, geo_error = ? WHERE id = ? AND geo_manual = 0");
  const noIp = db.prepare('UPDATE panels SET geo_error = ? WHERE id = ? AND geo_manual = 0 AND geo_lat IS NULL');
  const todo: { id: number; ip: string }[] = [];
  for (const p of listPanels(db)) {
    if (p.geo_manual) continue;
    const ip = geoIpOf(p);
    if (!ip) {
      if (p.geo_lat == null && p.geo_error !== NO_IP) noIp.run(NO_IP, p.id);
      continue;
    }
    if (due(p, ip, now)) todo.push({ id: p.id, ip });
  }
  const start = Date.now();
  // 同一个 IP 的几块面板只查一次
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
