// 订阅拉取记录:每次带有效 token 拉订阅记一条(哪个客户、客户端 UA、来源 IP、给的格式、结果),保留几天后删掉。

import type { Request } from 'express';
import type { DB } from '../db';

const DAY_MS = 86_400_000;

export interface SubFetch {
  at: number;
  customer_id: number;
  /** 给的格式(clash / singbox / base64 等) */
  target: string;
  status: number;
  ua: string;
  ip: string;
}

/** 客户端真实 IP:经 Cloudflare 隧道回源时取 CF-Connecting-IP(由 Cloudflare 填写,客户端改不了) */
export function clientIp(req: Request): string {
  return req.get('cf-connecting-ip') || req.ip || '';
}

export function recordSubFetch(db: DB, f: SubFetch): void {
  db.prepare('INSERT INTO sub_fetches (at, customer_id, target, status, ua, ip) VALUES (?, ?, ?, ?, ?, ?)').run(
    f.at,
    f.customer_id,
    f.target,
    f.status,
    f.ua.slice(0, 300),
    f.ip.slice(0, 64),
  );
}

export function listSubFetches(db: DB, customerId: number, limit = 500): SubFetch[] {
  return db
    .prepare('SELECT at, customer_id, target, status, ua, ip FROM sub_fetches WHERE customer_id = ? ORDER BY at DESC LIMIT ?')
    .all(customerId, limit) as SubFetch[];
}

/** 每个客户 since 以来用了几个客户端(按 UA 区分)、来自几个 IP。同版本同型号的两台设备会算成一个,升级了版本会多算一个 */
export function subClientCounts(db: DB, since: number): Map<number, { clients: number; ips: number }> {
  const rows = db
    .prepare('SELECT customer_id, COUNT(DISTINCT ua) AS clients, COUNT(DISTINCT ip) AS ips FROM sub_fetches WHERE at >= ? GROUP BY customer_id')
    .all(since) as { customer_id: number; clients: number; ips: number }[];
  return new Map(rows.map((r) => [r.customer_id, { clients: r.clients, ips: r.ips }]));
}

export function pruneSubFetches(db: DB, days: number, now = Date.now()): number {
  return db.prepare('DELETE FROM sub_fetches WHERE at < ?').run(now - days * DAY_MS).changes;
}
