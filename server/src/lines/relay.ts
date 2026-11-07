// 中转线路的出口与路由:
// - 出口可以是 SOCKS 页登记的代理,或落地面板上的 socks(mixed)入站(选已有的,或新建一个带随机账号的);
// - 在中转的 Xray 配置里补一个指向出口的 socks 出站(已有同地址同账号的就复用)和一条「这个入站 → 该出站」的规则,
//   规则放在第一条不限入站的兜底规则之前(否则会被兜底规则抢走),然后重启 Xray。
// 同一个入站上的所有客户端共用这条规则,也就是共用同一个出口。

import { randomBytes } from 'node:crypto';
import type { DB } from '../db';
import { pickPort } from '../clients/create';
import { getPanel, InputError, type Panel } from '../panels/repo';
import { getSocks } from '../socks/repo';
import { decodeJson, xrayConfig } from '../xui/json';

export const DEFAULT_TEST_URL = 'https://www.google.com/generate_204';

export interface ExitServer {
  address: string;
  port: number;
  user: string;
  pass: string;
}

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
  /** 在落地上新建了 socks 入站 */
  created_inbound: string | null;
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

/** 把出口变成中转能连的 socks 服务器;落地上没有可用的 socks 入站就新建一个 */
export async function prepareExit(db: DB, spec: ExitSpec, adminFor: (panel: Panel) => ExitAdmin, relayHost: string): Promise<PreparedExit> {
  if (spec.kind === 'socks') {
    const s = getSocks(db, spec.socks_id);
    if (!s) throw new InputError('SOCKS 不存在');
    return {
      server: { address: s.host, port: s.port, user: s.username, pass: s.password },
      label: `SOCKS ${s.name}`,
      exit_kind: 'socks',
      exit_panel_id: null,
      exit_port: null,
      exit_socks_id: s.id,
      created_inbound: null,
    };
  }
  const landing = getPanel(db, spec.panel_id);
  if (!landing) throw new InputError('落地面板不存在');
  const address = new URL(landing.base_url).hostname;
  if (address === relayHost) throw new InputError('落地和中转是同一块面板');
  const admin = adminFor(landing);
  try {
    const inbounds = await admin.listInbounds();
    let ib: any;
    let created: string | null = null;
    if (spec.inbound_id != null) {
      ib = inbounds.find((x) => Number(x.id) === spec.inbound_id);
      if (!ib) throw new InputError('落地上没有这个入站');
      if (!isSocksInbound(ib)) throw new InputError('落地上给中转用的入站要是 socks / mixed 协议且启用');
    } else {
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
      exit_kind: 'panel',
      exit_panel_id: landing.id,
      exit_port: Number(ib.port),
      exit_socks_id: null,
      created_inbound: created,
    };
  } finally {
    await admin.close?.().catch(() => {});
  }
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

/** 让 inboundTag 这个入站走指定出口:去掉它在旧规则里的身影,把新规则放在第一条不限入站的兜底规则之前。返回出站 tag */
export function routeToExit(xray: any, inboundTag: string, server: ExitServer): string {
  const outTag = ensureOutbound(xray, server);
  const rules: any[] = Array.isArray(xray.routing?.rules) ? xray.routing.rules : [];
  const kept: any[] = [];
  for (const r of rules) {
    if (Array.isArray(r?.inboundTag) && r.inboundTag.includes(inboundTag) && plainRule(r)) {
      // 这条规则只管这个入站就整条删掉,还管别的入站就把这个入站摘出来
      const rest = r.inboundTag.filter((t: string) => t !== inboundTag);
      if (!rest.length) continue;
      kept.push({ ...r, inboundTag: rest });
    } else kept.push(r);
  }
  const rule = { type: 'field', inboundTag: [inboundTag], outboundTag: outTag };
  const fallback = kept.findIndex((r) => r?.enabled !== false && !r?.inboundTag?.length && plainRule(r) && (r?.outboundTag || r?.balancerTag));
  if (fallback >= 0) kept.splice(fallback, 0, rule);
  else kept.push(rule);
  xray.routing = { ...(xray.routing ?? {}), rules: kept };
  return outTag;
}

/** 读中转的 Xray 配置 → 改路由 → 写回 → 重启 Xray(上面所有客户端断流几秒) */
export async function applyRoute(admin: RouteAdmin, inboundTag: string, server: ExitServer): Promise<string> {
  const raw = await admin.xraySettings();
  const xray = xrayConfig(raw);
  if (!Array.isArray(xray.outbounds) || !xray.outbounds.length) throw new Error('读到的 Xray 配置不完整(没有出站)');
  const outTag = routeToExit(xray, inboundTag, server);
  await admin.updateXray(xray, decodeJson(raw)?.outboundTestUrl || DEFAULT_TEST_URL);
  await admin.restartXray();
  return outTag;
}
