// 订阅的设备:每个拉过订阅的客户端记一台(按 UA 区分;客户端带 x-hwid 头的按它区分),附带最近的来源 IP。
// 客户设了设备数上限后,名额满了新设备拉订阅就失败,要客户在自助页(或管理员在后台)删掉一台旧的才行。
// 不动面板:限制只在订阅链接上,已经拿到节点的设备不受影响。

import type { Request } from 'express';
import type { DB } from '../db';
import { InputError } from '../panels/repo';

const DAY_MS = 86_400_000;
/** 这么多天没再拉过订阅的设备自动清掉,名额让出来(客户端一般每天更新一次订阅) */
export const DEVICE_IDLE_DAYS = 30;
/** 没设上限的客户最多记这么多台(再多的照样放行,只是不记),免得有人拿着订阅链接换 UA 把表刷大 */
const MAX_TRACKED = 200;

export interface SubDevice {
  id: number;
  customer_id: number;
  ua: string;
  ip: string;
  first_at: number;
  last_at: number;
}

/** 设备的标识:有 x-hwid 就用它(Happ、v2RayTun 等会带),否则用整条 UA */
export function deviceKey(req: Pick<Request, 'get'>): string {
  const hwid = (req.get('x-hwid') ?? '').trim();
  return hwid ? `hwid:${hwid.slice(0, 128)}` : `ua:${(req.get('user-agent') ?? '').slice(0, 300)}`;
}

/** UA 去掉版本号:同一个客户端升级前后是一样的 */
const appOf = (ua: string) => ua.replace(/[\d.]+/g, '');

export function listDevices(db: DB, customerId: number): SubDevice[] {
  return db.prepare('SELECT id, customer_id, ua, ip, first_at, last_at FROM sub_devices WHERE customer_id = ? ORDER BY last_at DESC').all(customerId) as SubDevice[];
}

export function deviceCounts(db: DB): Map<number, number> {
  const rows = db.prepare('SELECT customer_id, COUNT(*) AS n FROM sub_devices GROUP BY customer_id').all() as { customer_id: number; n: number }[];
  return new Map(rows.map((r) => [r.customer_id, r.n]));
}

/**
 * 这次拉订阅放不放行,顺带登记 / 更新设备。limit = 0 不限(照样登记,以后设上限时已有的设备都算在内)。
 * - 认识的设备:放行;
 * - 新设备、名额没满:登记后放行;
 * - 新设备、名额满了:同一个客户端升级了版本(去掉版本号后 UA 一样,来源 IP 也和那台上次的一样)就顶替原来那台,否则拒绝。
 */
export function admitDevice(db: DB, customerId: number, limit: number, d: { key: string; ua: string; ip: string }, now = Date.now()): boolean {
  const ua = d.ua.slice(0, 300);
  const ip = d.ip.slice(0, 64);
  if (db.prepare('UPDATE sub_devices SET last_at = ?, ip = ?, ua = ? WHERE customer_id = ? AND key = ?').run(now, ip, ua, customerId, d.key).changes) return true;
  const known = db.prepare('SELECT id, key, ua, ip FROM sub_devices WHERE customer_id = ?').all(customerId) as { id: number; key: string; ua: string; ip: string }[];
  if (limit > 0 && known.length >= limit) {
    const upgraded = d.key.startsWith('ua:') && ip ? known.find((k) => k.key.startsWith('ua:') && k.ip === ip && appOf(k.ua) === appOf(ua)) : undefined;
    if (!upgraded) return false;
    db.prepare('UPDATE sub_devices SET key = ?, ua = ?, last_at = ? WHERE id = ?').run(d.key, ua, now, upgraded.id);
    return true;
  }
  if (known.length < MAX_TRACKED) db.prepare('INSERT INTO sub_devices (customer_id, key, ua, ip, first_at, last_at) VALUES (?, ?, ?, ?, ?, ?)').run(customerId, d.key, ua, ip, now, now);
  return true;
}

export function deleteDevice(db: DB, customerId: number, deviceId: number): void {
  if (!db.prepare('DELETE FROM sub_devices WHERE id = ? AND customer_id = ?').run(deviceId, customerId).changes) throw new InputError('设备不存在');
}

export function pruneDevices(db: DB, now = Date.now()): number {
  return db.prepare('DELETE FROM sub_devices WHERE last_at < ?').run(now - DEVICE_IDLE_DAYS * DAY_MS).changes;
}
