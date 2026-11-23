// 订阅拉取记录:每次带有效 token 拉订阅记一条(哪个客户、客户端 UA、来源 IP、给的格式、结果),保留几天后删掉。

import type { Request } from 'express';
import { BlockList, isIP } from 'node:net';
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

/** 本机、内网(Cloudflare 隧道的 cloudflared、本机的反向代理从这里连进来) */
const LOCAL = new BlockList();
for (const [net, bits] of [['127.0.0.0', 8], ['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16]] as const) LOCAL.addSubnet(net, bits, 'ipv4');
for (const [net, bits] of [['::1', 128], ['fc00::', 7]] as const) LOCAL.addSubnet(net, bits, 'ipv6');

/** Cloudflare 回源用的地址段(https://www.cloudflare.com/ips/) */
const CLOUDFLARE = new BlockList();
for (const c of ['173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18', '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13', '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22']) {
  const [net, bits] = c.split('/');
  CLOUDFLARE.addSubnet(net, Number(bits), 'ipv4');
}
for (const c of ['2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32', '2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32']) {
  const [net, bits] = c.split('/');
  CLOUDFLARE.addSubnet(net, Number(bits), 'ipv6');
}

/** ::ffff:1.2.3.4 这种 IPv4 映射地址还原成 1.2.3.4 */
const plain = (ip: string) => (ip.startsWith('::ffff:') && isIP(ip.slice(7)) === 4 ? ip.slice(7) : ip);
const inList = (list: BlockList, ip: string) => {
  const v = isIP(ip);
  return v === 4 ? list.check(ip, 'ipv4') : v === 6 ? list.check(ip, 'ipv6') : false;
};

/**
 * 客户端真实 IP。CF-Connecting-IP 只在请求确实是经 Cloudflare 来的时候才认:直接连过来的是本机 / 内网(Cloudflare 隧道的 cloudflared、
 * 本机反向代理)或 Cloudflare 的回源地址。公网直连的(一键脚本、Docker 默认就是)这个头谁都能填,不认,用连接的地址
 */
export function clientIp(req: Request): string {
  const peer = plain(req.socket?.remoteAddress ?? '');
  const ip = plain(req.ip || peer);
  const cf = req.get('cf-connecting-ip')?.trim();
  if (cf && isIP(cf) && (inList(LOCAL, peer) || inList(CLOUDFLARE, peer) || inList(CLOUDFLARE, ip))) return cf;
  return ip;
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

/** since 以来各客户的订阅从哪些 IP 拉过(成功的才算),给「疑似分享」用 */
export function subIpsSince(db: DB, since: number): Map<number, string[]> {
  const rows = db.prepare("SELECT DISTINCT customer_id, ip FROM sub_fetches WHERE at >= ? AND status = 200 AND ip <> ''").all(since) as { customer_id: number; ip: string }[];
  const out = new Map<number, string[]>();
  for (const r of rows) out.set(r.customer_id, [...(out.get(r.customer_id) ?? []), r.ip]);
  return out;
}
