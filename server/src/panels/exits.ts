// 线路的落地 IP:按各面板最新的配置快照(每小时一份,开通线路后补一份)推算,不现连面板。
// client 挂的入站 → Xray 路由 → 出站:直出 = 这台机器的 IP;转到自己另一台面板 = 跟到那台面板同端口的入站继续推;
// 登记过的 SOCKS = 测出的出口 IP(没测过用它的地址);其他出站 = 出站地址。
// 结果按「各面板最新快照 + 面板 / SOCKS 登记」缓存,有变化才重算。

import type { DB } from '../db';
import { decodeJson } from '../xui/json';
import { addDomainHosts, panelHosts } from './hosts';
import { resolveRoute } from './inbounds';
import { listPanels, type Panel } from './repo';
import { loadSnapshot, type SnapshotData } from './snapshots';

export interface LineExit {
  ip: string;
  /** 怎么到的:本机直出 / 经某台面板 / SOCKS 名 / 出站地址 */
  via: string;
  /** 途经的自己的面板(不含线路所在的那台),如中转 → 落地 → SOCKS 时是 [落地] */
  through: number[];
}

/** 键 `${panel_id}:${email}` */
export type ExitMap = Map<string, LineExit[]>;

export const exitKey = (panelId: number, email: string) => `${panelId}:${email}`;

/** 跟着「转到自己另一台面板」最多跟几层 */
const MAX_HOPS = 3;

interface SocksRow {
  name: string;
  host: string;
  port: number;
  check_ip: string | null;
}

interface Ctx {
  panels: Map<string, Panel>;
  hosts: Map<string, string>;
  socks: SocksRow[];
  snaps: Map<number, SnapshotData>;
}

function outboundTarget(o: any): { host: string; port: number } {
  const s = decodeJson(o?.settings) ?? {};
  const server = (s.servers ?? s.vnext ?? [])[0] ?? {};
  return { host: String(server.address ?? '').toLowerCase(), port: Number(server.port) };
}

/** 某台面板上某个入站的落地;through 是已经途经的面板 */
function inboundExit(ctx: Ctx, panel: Panel, inbound: any, emails: string[], through: number[]): LineExit | null {
  const snap = ctx.snaps.get(panel.id);
  if (!snap || !inbound?.tag) return null;
  const { route } = resolveRoute(snap.xray, String(inbound.tag), emails, {
    panelHosts: ctx.hosts,
    socks: ctx.socks.map((s) => ({ name: s.name, host: s.host.toLowerCase(), port: s.port })),
  });
  if (route.kind === 'block') return null;
  if (route.kind === 'direct') return panel.ip ? { ip: panel.ip, via: through.length ? `经 ${panel.name}` : '本机直出', through } : null;
  const o = (Array.isArray(snap.xray?.outbounds) ? snap.xray.outbounds : []).find((x: any) => x?.tag === route.outbound);
  const { host, port } = outboundTarget(o);
  if (route.kind === 'socks') {
    const sk = ctx.socks.find((s) => s.host.toLowerCase() === host && s.port === port);
    return { ip: sk?.check_ip || host, via: `SOCKS ${sk?.name ?? host}`, through };
  }
  if (route.kind === 'panel') {
    const next = ctx.panels.get(route.label);
    if (!next) return null;
    const path = [...through, next.id];
    // 跟到那台面板上收这个端口的入站;跟不下去就算那台机器的 IP
    const nextInbound = ctx.snaps.get(next.id)?.inbounds.find((i) => Number(i.port) === port);
    const deeper = nextInbound && through.length < MAX_HOPS ? inboundExit(ctx, next, nextInbound, [], path) : null;
    return deeper ?? (next.ip ? { ip: next.ip, via: `经 ${next.name}`, through: path } : null);
  }
  return host ? { ip: host, via: `出站 ${host}`, through } : null;
}

function compute(ctx: Ctx): ExitMap {
  const map: ExitMap = new Map();
  for (const panel of ctx.panels.values()) {
    const snap = ctx.snaps.get(panel.id);
    if (!snap) continue;
    const byId = new Map(snap.inbounds.map((i) => [Number(i.id), i]));
    for (const { client, inboundIds } of snap.clients) {
      const email = String(client?.email ?? '');
      const exits: LineExit[] = [];
      for (const id of inboundIds) {
        const exit = inboundExit(ctx, panel, byId.get(id), [email], []);
        if (exit && !exits.some((e) => e.ip === exit.ip && e.via === exit.via)) exits.push(exit);
      }
      if (exits.length) map.set(exitKey(panel.id, email), exits);
    }
  }
  return map;
}

let cache: { key: string; map: ExitMap } | null = null;

/** 全部 client 的落地 IP(读不到快照的面板上的 client 没有结果) */
export async function lineExits(db: DB): Promise<ExitMap> {
  const latest = db.prepare('SELECT panel_id, MAX(id) AS id FROM panel_snapshots GROUP BY panel_id').all() as { panel_id: number; id: number }[];
  const panels = listPanels(db);
  const socks = db.prepare('SELECT name, host, port, check_ip FROM socks_proxies ORDER BY id').all() as SocksRow[];
  const key = JSON.stringify([latest, panels.map((p) => [p.id, p.name, p.ip, p.base_url]), socks]);
  if (cache?.key === key) return cache.map;

  const snaps = new Map<number, SnapshotData>();
  for (const { panel_id, id } of latest) snaps.set(panel_id, loadSnapshot(db, panel_id, id));
  const hosts = await panelHosts(panels);
  const outboundHosts = [...snaps.values()].flatMap((s) => (Array.isArray(s.xray?.outbounds) ? s.xray.outbounds : []).map((o: any) => outboundTarget(o).host));
  await addDomainHosts(outboundHosts, hosts);
  const map = compute({ panels: new Map(panels.map((p) => [p.name, p])), hosts, socks, snaps });
  cache = { key, map };
  return map;
}
