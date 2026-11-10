// 中转线路的出口与路由:
// - 出口可以是 SOCKS 页登记的代理,或落地面板上的 socks(mixed)入站(指定一个已有的;不指定就用本系统建过的 relay-socks,没有才新建);
// - 在中转的 Xray 配置里补一个指向出口的 socks 出站(已有同地址同账号的就复用)和一条「这个入站 + 这个客户端(user = email)→ 该出站」
//   的规则,放在会接住这个入站流量的兜底规则之前,然后重启 Xray;规则去掉后没人用的出站一并删掉。
// 规则按客户端区分:同一个入站上的客户端可以各走各的出口,没配规则的客户端照旧按入站 / 全局的兜底规则走(一般是直出)。

import { randomBytes } from 'node:crypto';
import type { DB } from '../db';
import { pickPort } from '../clients/create';
import { getPanel, InputError, type Panel } from '../panels/repo';
import { getSocks, type SocksEndpoint } from '../socks/repo';
import { using } from '../util';
import { decodeJson, xrayConfig } from '../xui/json';

export const DEFAULT_TEST_URL = 'https://www.google.com/generate_204';

export interface ExitServer {
  address: string;
  port: number;
  user: string;
  pass: string;
}

export const socksServer = (s: SocksEndpoint): ExitServer => ({ address: s.host, port: s.port, user: s.username, pass: s.password });

export type ExitSpec =
  | { kind: 'socks'; socks_id: number }
  | { kind: 'panel'; panel_id: number; inbound_id?: number | null };

export interface PreparedExit {
  server: ExitServer;
  label: string;
  exit_kind: 'panel' | 'socks';
  exit_panel_id: number | null;
  exit_port: number | null;
  exit_socks_id: number | null;
  /** 这次在落地上新建的 socks 入站(名字和 id,开线路失败时按 id 删掉);复用已有的为 null */
  created_inbound: string | null;
  created_inbound_id: number | null;
}

export interface ExitAdmin {
  listInbounds(): Promise<any[]>;
  addInbound(body: unknown): Promise<void>;
  close?(): Promise<void>;
}

export interface RouteAdmin {
  xraySettings(): Promise<unknown>;
  updateXray(xray: unknown, testUrl: string): Promise<void>;
  restartXray(): Promise<void>;
}

const isSocksInbound = (ib: any) => ['mixed', 'socks'].includes(String(ib?.protocol)) && ib?.enable !== false;
/** 本系统在落地上建的 socks 入站的名字 */
const OWN_REMARK = /^relay-socks(-\d+)?$/;

/** 落地上给中转用的 socks 入站:mixed 协议、用户名密码认证、只收 TCP 代理请求 */
export function builtinMixedInbound(port: number, remark: string, user: string, pass: string): any {
  return {
    up: 0,
    down: 0,
    total: 0,
    remark,
    enable: true,
    expiryTime: 0,
    listen: '',
    port,
    protocol: 'mixed',
    settings: JSON.stringify({ auth: 'password', accounts: [{ user, pass }], udp: true, ip: '127.0.0.1' }),
    streamSettings: JSON.stringify({ network: 'tcp', security: 'none', tcpSettings: { acceptProxyProtocol: false, header: { type: 'none' } } }),
    sniffing: JSON.stringify({ enabled: false, destOverride: [] }),
    allocate: JSON.stringify({ strategy: 'always', refresh: 5, concurrency: 3 }),
  };
}

/** 从 mixed / socks 入站的设置里取第一个账号 */
export function accountOf(ib: any): { user: string; pass: string } {
  const s = decodeJson(ib?.settings) ?? {};
  const acc = (s.accounts ?? [])[0] ?? {};
  return { user: String(acc.user ?? ''), pass: String(acc.pass ?? '') };
}

export function parseExitSpec(raw: any): ExitSpec {
  if (raw?.kind === 'socks') {
    const id = Number(raw.socks_id);
    if (!Number.isInteger(id) || id <= 0) throw new InputError('缺少 SOCKS');
    return { kind: 'socks', socks_id: id };
  }
  if (raw?.kind === 'panel') {
    const id = Number(raw.panel_id);
    if (!Number.isInteger(id) || id <= 0) throw new InputError('缺少落地面板');
    const ib = raw.inbound_id == null || raw.inbound_id === '' ? null : Number(raw.inbound_id);
    return { kind: 'panel', panel_id: id, inbound_id: ib };
  }
  throw new InputError('中转线路要选出口:落地面板或 SOCKS');
}

/** 把出口变成中转能连的 socks 服务器。落地没指定入站时用本系统建过的那个(名字是 relay-socks),没有才新建 */
export async function prepareExit(db: DB, spec: ExitSpec, adminFor: (panel: Panel) => ExitAdmin, relayHost: string): Promise<PreparedExit> {
  if (spec.kind === 'socks') {
    const s = getSocks(db, spec.socks_id);
    if (!s) throw new InputError('SOCKS 不存在');
    return {
      server: socksServer(s),
      label: `SOCKS ${s.name}`,
      exit_kind: 'socks',
      exit_panel_id: null,
      exit_port: null,
      exit_socks_id: s.id,
      created_inbound: null,
      created_inbound_id: null,
    };
  }
  const landing = getPanel(db, spec.panel_id);
  if (!landing) throw new InputError('落地面板不存在');
  const address = new URL(landing.base_url).hostname;
  if (address === relayHost) throw new InputError('落地和中转是同一块面板');
  return using(adminFor(landing), async (admin) => {
    const inbounds = await admin.listInbounds();
    let ib: any;
    let created: string | null = null;
    if (spec.inbound_id != null) {
      ib = inbounds.find((x) => Number(x.id) === spec.inbound_id);
      if (!ib) throw new InputError('落地上没有这个入站');
      if (!isSocksInbound(ib)) throw new InputError('落地上给中转用的入站要是 socks / mixed 协议且启用');
    } else {
      ib = inbounds.find((x) => isSocksInbound(x) && OWN_REMARK.test(String(x.remark ?? '')) && accountOf(x).user);
    }
    if (!ib) {
      const port = pickPort(landing, inbounds);
      const taken = new Set(inbounds.map((x) => String(x.remark ?? '')));
      let remark = 'relay-socks';
      for (let i = 2; taken.has(remark); i++) remark = `relay-socks-${i}`;
      const user = `r${randomBytes(4).toString('hex')}`;
      const pass = randomBytes(12).toString('base64url');
      await admin.addInbound(builtinMixedInbound(port, remark, user, pass));
      ib = (await admin.listInbounds()).find((x) => Number(x.port) === port && x.protocol === 'mixed');
      if (!ib) throw new Error('落地上新建 socks 入站后读回没找到');
      created = remark;
    }
    const acc = accountOf(ib);
    return {
      server: { address, port: Number(ib.port), user: acc.user, pass: acc.pass },
      label: `落地 ${landing.name}(${ib.remark || ib.port})`,
      exit_kind: 'panel' as const,
      exit_panel_id: landing.id,
      exit_port: Number(ib.port),
      exit_socks_id: null,
      created_inbound: created,
      created_inbound_id: created ? Number(ib.id) : null,
    };
  });
}

const serverOf = (o: any) => {
  const s = decodeJson(o?.settings) ?? {};
  const first = (s.servers ?? [])[0] ?? {};
  const u = (first.users ?? [])[0] ?? {};
  return { address: String(first.address ?? '').toLowerCase(), port: Number(first.port), user: String(u.user ?? ''), pass: String(u.pass ?? '') };
};

/** 中转上指向这个出口的 socks 出站:已有(地址、端口、账号都一致)就复用,没有就加一个;返回它的 tag */
export function ensureOutbound(xray: any, server: ExitServer): string {
  xray.outbounds = Array.isArray(xray.outbounds) ? xray.outbounds : [];
  const same = xray.outbounds.find((o: any) => {
    if (o?.protocol !== 'socks') return false;
    const v = serverOf(o);
    return v.address === server.address.toLowerCase() && v.port === server.port && v.user === server.user && v.pass === server.pass;
  });
  if (same?.tag) return String(same.tag);
  const taken = new Set(xray.outbounds.map((o: any) => String(o?.tag ?? '')));
  const base = `socks-${server.address}-${server.port}`;
  let tag = base;
  for (let i = 2; taken.has(tag); i++) tag = `${base}-${i}`;
  xray.outbounds.push({
    tag,
    protocol: 'socks',
    settings: { servers: [{ address: server.address, port: server.port, users: server.user || server.pass ? [{ user: server.user, pass: server.pass }] : [] }] },
  });
  return tag;
}

const CONDITIONS = ['domain', 'ip', 'port', 'sourcePort', 'source', 'protocol', 'attrs', 'user', 'network'];
/** 只按入站匹配(或不限入站)的兜底规则,没有别的条件 */
const plainRule = (r: any) => CONDITIONS.every((k) => r?.[k] == null || (Array.isArray(r[k]) && !r[k].length) || r[k] === '');

/** 是不是我们给某个客户端加的规则:只有 inboundTag + user 两个条件 */
const isUserRule = (r: any, inboundTag: string, email: string) =>
  Array.isArray(r?.inboundTag) && r.inboundTag.length === 1 && r.inboundTag[0] === inboundTag && Array.isArray(r?.user) && r.user.length === 1 && r.user[0] === email;

/** 会接住这个入站流量的兜底规则:不限入站、或点名这个入站,且没有别的条件 */
const catchesInbound = (r: any, inboundTag: string) => r?.enabled !== false && plainRule(r) && (r?.outboundTag || r?.balancerTag) && (!r?.inboundTag?.length || r.inboundTag.includes(inboundTag));

/** 本系统加的 socks 出站(tag 是 socks-…)没有规则、负载均衡、别的出站在用了就删掉 */
function dropUnusedOutbound(xray: any, tag: unknown): void {
  if (typeof tag !== 'string' || !tag.startsWith('socks-') || !Array.isArray(xray.outbounds)) return;
  const routing = xray.routing ?? {};
  const selectors: unknown[] = [
    ...(routing.balancers ?? []).flatMap((b: any) => [...(b?.selector ?? []), b?.fallbackTag]),
    ...(xray.observatory?.subjectSelector ?? []),
    ...(xray.burstObservatory?.subjectSelector ?? []),
  ];
  const used =
    (routing.rules ?? []).some((r: any) => r?.outboundTag === tag) ||
    selectors.some((s) => typeof s === 'string' && s !== '' && tag.startsWith(s)) ||
    xray.outbounds.some((o: any) => o?.proxySettings?.tag === tag || o?.streamSettings?.sockopt?.dialerProxy === tag);
  if (!used) xray.outbounds = xray.outbounds.filter((o: any) => !(o?.tag === tag && o?.protocol === 'socks'));
}

/**
 * 让 inboundTag 入站上的 email 这个客户端走指定出口:换掉他旧的规则,新规则放在会接住这个入站的兜底规则之前。
 * 已经是这样就不动(重做一遍不会多重启一次 Xray)。返回出站 tag
 */
export function routeUserToExit(xray: any, inboundTag: string, email: string, server: ExitServer): string {
  const outTag = ensureOutbound(xray, server);
  const all: any[] = Array.isArray(xray.routing?.rules) ? xray.routing.rules : [];
  const mine = all.filter((r) => isUserRule(r, inboundTag, email));
  const catchAt = all.findIndex((r) => catchesInbound(r, inboundTag));
  if (mine.length === 1 && mine[0].outboundTag === outTag && (catchAt < 0 || all.indexOf(mine[0]) < catchAt)) return outTag;
  const rules = all.filter((r) => !mine.includes(r));
  const rule = { type: 'field', inboundTag: [inboundTag], user: [email], outboundTag: outTag };
  const at = rules.findIndex((r) => catchesInbound(r, inboundTag));
  if (at >= 0) rules.splice(at, 0, rule);
  else rules.push(rule);
  xray.routing = { ...(xray.routing ?? {}), rules };
  for (const r of mine) dropUnusedOutbound(xray, r.outboundTag);
  return outTag;
}

/** 去掉某个客户端的出口规则(删线路时),他用的出站没人用了也删掉;没有这条规则就返回 false */
export function unrouteUser(xray: any, inboundTag: string, email: string): boolean {
  const rules: any[] = Array.isArray(xray.routing?.rules) ? xray.routing.rules : [];
  const mine = rules.filter((r) => isUserRule(r, inboundTag, email));
  if (!mine.length) return false;
  xray.routing = { ...(xray.routing ?? {}), rules: rules.filter((r) => !mine.includes(r)) };
  for (const r of mine) dropUnusedOutbound(xray, r.outboundTag);
  return true;
}

/** 读中转的 Xray 配置 → 改 → 有变化才写回并重启 Xray(上面所有客户端断流几秒)。返回改没改。调用方要先占住这块面板(panelKey) */
async function editXray(admin: RouteAdmin, edit: (xray: any) => void): Promise<boolean> {
  const raw = await admin.xraySettings();
  const xray = xrayConfig(raw);
  const before = JSON.stringify(xray);
  edit(xray);
  if (JSON.stringify(xray) === before) return false;
  await admin.updateXray(xray, decodeJson(raw)?.outboundTestUrl || DEFAULT_TEST_URL);
  await admin.restartXray();
  return true;
}

export interface UserRoute {
  inboundTag: string;
  email: string;
}

/** 给这些客户端加(或换)出口规则:一次写回、一次重启 */
export function applyRoutes(admin: RouteAdmin, routes: (UserRoute & { server: ExitServer })[]): Promise<boolean> {
  return editXray(admin, (xray) => {
    if (!Array.isArray(xray.outbounds) || !xray.outbounds.length) throw new Error('读到的 Xray 配置不完整(没有出站)');
    for (const r of routes) routeUserToExit(xray, r.inboundTag, r.email, r.server);
  });
}

/** 去掉这些客户端的出口规则:一次写回、一次重启;一条都没有就不动 */
export function removeRoutes(admin: RouteAdmin, users: UserRoute[]): Promise<boolean> {
  return editXray(admin, (xray) => {
    for (const u of users) unrouteUser(xray, u.inboundTag, u.email);
  });
}
