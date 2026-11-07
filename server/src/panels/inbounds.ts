// 面板详情:现取一台面板的入站、各入站的去向(按 Xray 路由规则)和挂在上面的 client。
// 只读;不返回任何密钥(uuid、密码、reality 私钥、证书路径等)。

import type { DB } from '../db';
import { allSocks } from '../socks/repo';
import type { XrayReader } from '../socks/usage';
import { decodeJson as decode, xrayConfig } from '../xui/json';
import { normalizeClients } from '../xui/normalize';
import { addDomainHosts, panelHosts } from './hosts';
import { listPanels, type Panel } from './repo';

export interface PanelReader extends XrayReader {
  listInbounds(): Promise<any[]>;
  listClients(): Promise<any[]>;
}

/** direct = 本机直出;panel = 转到自己的另一台面板机器;socks = 已登记的 SOCKS;other = 其他出站;block = 封锁 */
export type RouteKind = 'direct' | 'panel' | 'socks' | 'other' | 'block';

export interface InboundRoute {
  kind: RouteKind;
  label: string;
  outbound: string | null;
}

export interface PanelClientView {
  email: string;
  enable: boolean;
  up: number;
  down: number;
  total_bytes: number;
  expiry_ms: number;
  last_online: number;
  customer: { id: number; name: string } | null;
}

export interface InboundView {
  id: number;
  remark: string;
  protocol: string;
  port: number;
  enable: boolean;
  /** 传输 / 安全,如 tcp / reality */
  transport: string;
  route: InboundRoute;
  /** 另外还有几条只对部分流量生效的规则(按客户、按域名 / IP 等) */
  extra_rules: number;
  clients: PanelClientView[];
}

export interface PanelDetail {
  panel: { id: number; name: string; role: string; ip: string | null };
  fetched_at: number;
  inbounds: InboundView[];
  /** 没挂在任何入站上的 client */
  unattached: PanelClientView[];
}

const CONDITIONS = ['domain', 'ip', 'port', 'sourcePort', 'source', 'protocol', 'attrs'];

/** 只按入站匹配、没有其他条件的规则(network 只限 udp 的也算有条件) */
export function plainInboundRule(r: any): boolean {
  if (r?.user?.length) return false;
  if (CONDITIONS.some((k) => r?.[k] != null && (!Array.isArray(r[k]) || r[k].length))) return false;
  return !(r?.network && !String(r.network).includes('tcp'));
}

export interface RouteContext {
  /** 主机名 / IP(小写)→ 面板名 */
  panelHosts: Map<string, string>;
  socks: { name: string; host: string; port: number }[];
}

/** 按 Xray 规则顺序找入站的主去向:第一条只按入站匹配的规则,没有就走第一个出站 */
export function resolveRoute(xray: any, inboundTag: string, emails: string[], ctx: RouteContext): { route: InboundRoute; extra: number } {
  const rules: any[] = (Array.isArray(xray?.routing?.rules) ? xray.routing.rules : []).filter((r: any) => r?.enabled !== false);
  const outbounds: any[] = Array.isArray(xray?.outbounds) ? xray.outbounds : [];
  const mine = (r: any) => Array.isArray(r?.inboundTag) && r.inboundTag.includes(inboundTag);
  // 不限入站、不限客户的规则对所有入站生效
  const global = (r: any) => !r?.inboundTag?.length && !r?.user?.length;
  const main = rules.find((r) => (mine(r) || global(r)) && plainInboundRule(r) && (r.outboundTag || r.balancerTag));
  const users = new Set(emails);
  const extra = rules.filter(
    (r) => r !== main && ((mine(r) && !plainInboundRule(r)) || (!r.inboundTag?.length && Array.isArray(r.user) && r.user.some((u: string) => users.has(u)))),
  ).length;
  if (main?.balancerTag) return { route: { kind: 'other', label: `负载均衡 ${main.balancerTag}`, outbound: String(main.balancerTag) }, extra };
  const tag = main?.outboundTag ?? outbounds[0]?.tag ?? null;
  const o = outbounds.find((x) => x?.tag === tag);
  return { route: describeOutbound(o, tag, ctx), extra };
}

function describeOutbound(o: any, tag: string | null, ctx: RouteContext): InboundRoute {
  if (!o) return { kind: 'other', label: tag ? `找不到出站 ${tag}` : '没有出站', outbound: tag };
  if (o.protocol === 'freedom') return { kind: 'direct', label: '本机直出', outbound: tag };
  if (o.protocol === 'blackhole') return { kind: 'block', label: '封锁', outbound: tag };
  const s = decode(o.settings) ?? {};
  const host = outboundHost(o);
  const port = Number(((s.servers ?? s.vnext ?? [])[0] ?? {}).port);
  const panel = ctx.panelHosts.get(host);
  if (panel) return { kind: 'panel', label: panel, outbound: tag };
  const sk = ctx.socks.find((k) => k.host === host && k.port === port);
  if (sk) return { kind: 'socks', label: `SOCKS ${sk.name}`, outbound: tag };
  return { kind: 'other', label: host ? `${o.protocol} ${host}:${port}` : `${o.protocol} ${tag}`, outbound: tag };
}

/** 出站的服务器地址 */
function outboundHost(o: any): string {
  const s = decode(o?.settings) ?? {};
  return String(((s.servers ?? s.vnext ?? [])[0] ?? {}).address ?? '').toLowerCase();
}

export function buildPanelDetail(
  db: DB,
  panel: Panel,
  raw: { inbounds: any[]; clients: any[]; xray: unknown },
  ctx: RouteContext,
  now = Date.now(),
): PanelDetail {
  const xray = xrayConfig(raw.xray);
  const owners = new Map<string, { id: number; name: string }>();
  for (const row of db
    .prepare('SELECT b.email, c.id, c.name FROM bindings b JOIN customers c ON c.id = b.customer_id WHERE b.panel_id = ?')
    .all(panel.id) as any[]) {
    owners.set(row.email, { id: row.id, name: row.name });
  }
  const clients = normalizeClients(raw.clients, raw.inbounds);
  const view = (c: (typeof clients)[number]): PanelClientView => ({
    email: c.email,
    enable: c.enable,
    up: c.up,
    down: c.down,
    total_bytes: c.totalBytes,
    expiry_ms: c.expiryMs,
    last_online: c.lastOnline,
    customer: owners.get(c.email) ?? null,
  });
  const byName = (a: PanelClientView, b: PanelClientView) =>
    (a.customer?.name ?? '￿').localeCompare(b.customer?.name ?? '￿', 'zh-CN') || a.email.localeCompare(b.email, 'zh-CN');

  const inbounds = raw.inbounds.map((ib): InboundView => {
    const id = Number(ib.id);
    const on = clients.filter((c) => c.inboundIds.includes(id));
    const stream = decode(ib.streamSettings) ?? {};
    const { route, extra } = resolveRoute(xray, String(ib.tag ?? ''), on.map((c) => c.email), ctx);
    return {
      id,
      remark: String(ib.remark ?? ''),
      protocol: String(ib.protocol ?? ''),
      port: Number(ib.port),
      enable: ib.enable !== false,
      transport: [stream.network, stream.security && stream.security !== 'none' ? stream.security : ''].filter(Boolean).join(' / '),
      route,
      extra_rules: extra,
      clients: on.map(view).sort(byName),
    };
  });
  const ids = new Set(inbounds.map((i) => i.id));
  return {
    panel: { id: panel.id, name: panel.name, role: panel.role, ip: panel.ip ?? null },
    fetched_at: now,
    inbounds,
    unattached: clients.filter((c) => !c.inboundIds.some((i) => ids.has(i))).map(view).sort(byName),
  };
}

export async function readPanelDetail(db: DB, panel: Panel, reader: PanelReader): Promise<PanelDetail> {
  try {
    const [inbounds, clients, raw] = await Promise.all([reader.listInbounds(), reader.listClients(), reader.xraySettings()]);
    const xray = xrayConfig(raw);
    const hosts = await panelHosts(listPanels(db));
    await addDomainHosts((Array.isArray(xray.outbounds) ? xray.outbounds : []).map(outboundHost), hosts);
    const socks = allSocks(db).map((s) => ({ name: s.name, host: s.host.toLowerCase(), port: s.port }));
    return buildPanelDetail(db, panel, { inbounds, clients, xray }, { panelHosts: hosts, socks });
  } finally {
    await reader.close?.();
  }
}
