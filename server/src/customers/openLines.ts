// 按出口开通线路:现取各台中转的入站和路由,按出口(转到哪台落地 / 哪个 SOCKS / 中转本机直出)分组;
// 选定出口后,在每台中转上挑通往它的入站,给客户新建 client 并绑定。客户在该中转上已有通往同一出口的线路就跳过。
// 新建的 client 不设到期和流量上限(由本系统管),启用状态跟客户是否正常一致。
// 中转上还没有通往这个出口的入站时(登记过的 SOCKS、带 mixed 入站的落地、本机直出),照这台中转上现有的同类入站
// 新建一个(换个端口,名字按 <国家>-<出口 IP>-<中转后缀>),补出站(已有指向同一地址的就复用)和路由规则,重启 Xray 后再开 client。
// 改之前先存一份配置快照;规则加在最后,让已有的封锁规则和按客户的规则照常先生效,加完按路由解析核对确实通往这个出口。

import { randomBytes, randomUUID } from 'node:crypto';
import { connect } from 'node:net';
import type { DB } from '../db';
import { addDomainHosts, panelHosts } from '../panels/hosts';
import { resolveRoute, type PanelReader, type RouteContext } from '../panels/inbounds';
import { InputError, listPanels, type Panel } from '../panels/repo';
import { DEFAULT_TEST_URL, loadSnapshot, takeSnapshot } from '../panels/snapshots';
import { decodeJson, xrayConfig } from '../xui/json';
import { addBinding, getCustomer } from './repo';

export interface PanelLineAdmin extends PanelReader {
  addClient(client: unknown, inboundIds: number[]): Promise<void>;
  // 以下是中转上没有通往出口的入站、要新建时才用
  exportClients(): Promise<any[]>;
  addInbound(body: unknown): Promise<void>;
  deleteInbound(id: number): Promise<void>;
  updateXray(xray: unknown, testUrl: string): Promise<void>;
  restartXray(): Promise<void>;
}

/** 能给客户开 client 的协议(shadowsocks 等的密钥格式各异,不自动开) */
export const CLIENT_PROTOCOLS = new Set(['vless', 'vmess', 'trojan', 'hysteria']);

export interface RelayPlan {
  panel_id: number;
  panel_name: string;
  /** 选中的入站;null = 这台中转没有通往该出口的入站 */
  inbound: { id: number; remark: string; protocol: string; port: number } | null;
  /** 没有入站时能新建:照 template 这个入站新建一个,名字 remark;null = 建不了 */
  create: { remark: string; protocol: string; template: string } | null;
  /** 客户在这台中转上已有通往该出口的线路 */
  existing: { email: string; inbound: string } | null;
}

export interface ExitOption {
  key: string;
  label: string;
  relays: RelayPlan[];
}

export interface LinePlan {
  exits: ExitOption[];
  errors: { panel: string; error: string }[];
}

export interface OpenLineResult {
  panel: string;
  inbound: string;
  email: string;
  ok: boolean;
  /** 这台中转上为它新建了入站(并重启了 Xray) */
  created?: boolean;
  error?: string;
}

export interface RelayData {
  panel: Panel;
  inbounds: any[];
  clients: any[];
  xray: any;
}

export interface SocksRow {
  name: string;
  host: string;
  port: number;
  username: string;
  password: string;
  check_ip: string | null;
  check_loc: string | null;
}

/** 新建入站时出站要指向哪里;socks / 落地带账号,只在服务端用 */
export interface ExitTarget {
  kind: 'socks' | 'panel' | 'direct';
  /** 出口 IP(起名用);本机直出时为空,用中转自己的 IP */
  ip: string | null;
  /** 国家代码(起名用) */
  country: string | null;
  server?: { address: string; port: number; user: string; pass: string };
  /** 落地面板名(认出已有的、指向这台落地的出站) */
  panel?: string;
}

export const exitOf = (kind: string, label: string): { key: string; label: string } | null =>
  kind === 'block' ? null : kind === 'direct' ? { key: 'direct', label: '各中转本机直出' } : { key: `${kind}:${label}`, label };

export async function readRelays(db: DB, adminFor: (panel: Panel) => PanelLineAdmin) {
  const relays = listPanels(db).filter((p) => p.enabled && p.role === 'relay');
  const errors: LinePlan['errors'] = [];
  const data: RelayData[] = [];
  await Promise.all(
    relays.map(async (panel) => {
      const reader = adminFor(panel);
      try {
        const [inbounds, clients, raw] = await Promise.all([reader.listInbounds(), reader.listClients(), reader.xraySettings()]);
        data.push({ panel, inbounds, clients, xray: xrayConfig(raw) });
      } catch (e) {
        errors.push({ panel: panel.name, error: e instanceof Error ? e.message : String(e) });
      } finally {
        await reader.close?.();
      }
    }),
  );
  data.sort((a, b) => a.panel.name.localeCompare(b.panel.name, 'zh-CN'));
  const hosts = await panelHosts(listPanels(db));
  const outboundHosts = data.flatMap((d) =>
    (Array.isArray(d.xray.outbounds) ? d.xray.outbounds : []).map((o: any) => {
      const s = decodeJson(o?.settings) ?? {};
      return String(((s.servers ?? s.vnext ?? [])[0] ?? {}).address ?? '');
    }),
  );
  await addDomainHosts(outboundHosts, hosts);
  const socks = db.prepare('SELECT name, host, port, username, password, check_ip, check_loc FROM socks_proxies ORDER BY id').all() as SocksRow[];
  const ctx: RouteContext = { panelHosts: hosts, socks: socks.map((s) => ({ name: s.name, host: s.host.toLowerCase(), port: s.port })) };
  // 暂停同步的中转上的线路还在客户订阅里,它们入站名的后缀也算占用(按最近一份配置快照)
  const pausedSuffixes = listPanels(db)
    .filter((p) => !p.enabled && p.role === 'relay')
    .map((p) => {
      const row = db.prepare('SELECT id FROM panel_snapshots WHERE panel_id = ? ORDER BY taken_at DESC, id DESC LIMIT 1').get(p.id) as { id: number } | undefined;
      return row ? suffixOf(loadSnapshot(db, p.id, row.id).inbounds) : '';
    })
    .filter(Boolean);
  return { data, errors, ctx, socks, pausedSuffixes };
}

/** 出口的 IP(用来优先挑名字里带这个 IP 的入站,如 us-1.2.3.4-a) */
export function exitIp(db: DB, key: string, relay: Panel, socks: { name: string; check_ip?: string | null }[]): string | null {
  if (key === 'direct') return relay.ip;
  if (key.startsWith('panel:')) return listPanels(db).find((p) => p.name === key.slice(6))?.ip ?? null;
  if (key.startsWith('socks:')) return socks.find((s) => `SOCKS ${s.name}` === key.slice(6))?.check_ip ?? null;
  return null;
}

const serverOf = (o: any) => {
  const s = (decodeJson(o?.settings)?.servers ?? [])[0] ?? {};
  return { address: String(s.address ?? '').toLowerCase(), port: Number(s.port) };
};

/** 落地上给中转用的 mixed / socks 入站(取最近一份配置快照);优先中转已经在用的那个端口 */
function landingProxy(db: DB, panel: Panel, usedPorts: Set<number>): ExitTarget['server'] | null {
  const row = db.prepare('SELECT id FROM panel_snapshots WHERE panel_id = ? ORDER BY taken_at DESC, id DESC LIMIT 1').get(panel.id) as { id: number } | undefined;
  if (!row || !panel.ip) return null;
  const proxies = loadSnapshot(db, panel.id, row.id).inbounds.filter((i) => ['mixed', 'socks'].includes(i.protocol) && i.enable !== false);
  const ib = proxies.find((i) => usedPorts.has(Number(i.port))) ?? proxies[0];
  if (!ib) return null;
  const s = decodeJson(ib.settings) ?? {};
  const account = s.auth === 'password' || s.accounts?.length ? (s.accounts ?? [])[0] ?? {} : {};
  return { address: panel.ip, port: Number(ib.port), user: String(account.user ?? ''), pass: String(account.pass ?? '') };
}

/** 能为它新建入站的出口:登记过的 SOCKS、带 mixed 入站的落地、各中转本机直出 */
export function exitTargets(db: DB, data: RelayData[], ctx: RouteContext, socks: SocksRow[]): Map<string, { label: string; target: ExitTarget }> {
  const out = new Map<string, { label: string; target: ExitTarget }>();
  for (const s of socks) {
    out.set(`socks:SOCKS ${s.name}`, {
      label: `SOCKS ${s.name}`,
      target: { kind: 'socks', ip: s.check_ip ?? s.host, country: s.check_loc, server: { address: s.host, port: s.port, user: s.username, pass: s.password } },
    });
  }
  for (const p of listPanels(db).filter((p) => p.enabled && p.role !== 'relay')) {
    // 中转上已有的、指向这台落地的出站端口
    const used = new Set(
      data.flatMap((d) => (Array.isArray(d.xray.outbounds) ? d.xray.outbounds : []).map(serverOf).filter((s: any) => ctx.panelHosts.get(s.address) === p.name).map((s: any) => s.port)),
    );
    const server = landingProxy(db, p, used);
    if (server) out.set(`panel:${p.name}`, { label: p.name, target: { kind: 'panel', ip: p.ip, country: null, server, panel: p.name } });
  }
  out.set('direct', { label: '各中转本机直出', target: { kind: 'direct', ip: null, country: null } });
  return out;
}

export const streamOf = (ib: any) => decodeJson(ib.streamSettings) ?? {};
const comboOf = (ib: any) => `${ib.protocol}/${streamOf(ib).network ?? ''}/${streamOf(ib).security ?? ''}`;

/** 新建入站照着哪个来:这台中转上通往落地 / SOCKS 的入站里最常见的那种(协议 / 传输 / 安全),取最早的一个 */
export function templateOf(routed: { ib: any; exit: { key: string } | null }[]): any | null {
  const usable = routed.filter((x) => CLIENT_PROTOCOLS.has(x.ib.protocol));
  const perExit = usable.filter((x) => x.exit && x.exit.key !== 'direct');
  const pool = (perExit.length ? perExit : usable).map((x) => x.ib);
  if (!pool.length) return null;
  const counts = new Map<string, number>();
  for (const ib of pool) counts.set(comboOf(ib), (counts.get(comboOf(ib)) ?? 0) + 1);
  const best = [...counts].sort((a, b) => b[1] - a[1])[0][0];
  return pool.filter((ib) => comboOf(ib) === best).sort((a, b) => Number(a.id) - Number(b.id))[0];
}

/** 这台中转入站名字的后缀(如 us-1.2.3.4-a 的 a),取最常见的 */
function suffixOf(inbounds: any[]): string {
  const counts = new Map<string, number>();
  for (const ib of inbounds) {
    const m = String(ib.remark ?? '').match(/^[a-z]{2}-[\w.:-]+-([a-z])$/i);
    if (m) counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
}

/** 还没有后缀的中转(新加的、香港中转这类)分一个别的中转没在用的字母,免得客户订阅里和别的中转的节点重名 */
function freeSuffix(relay: RelayData, all: RelayData[], pausedSuffixes: string[]): string {
  const used = new Set([...all.filter((d) => d.panel.id !== relay.panel.id).map((d) => suffixOf(d.inbounds)), ...pausedSuffixes].filter(Boolean));
  return 'abcdefghijklmnopqrstuvwxyz'.split('').find((c) => !used.has(c)) ?? '';
}

/** 新入站的名字:<国家>-<出口 IP>-<后缀>;国家取 SOCKS 测出的地区,否则沿用别处同出口入站的,再不行用各中转最常见的 */
export function remarkFor(target: ExitTarget, relay: RelayData, all: RelayData[], sameExitRemarks: string[], pausedSuffixes: string[] = []): string {
  const ip = target.ip ?? relay.panel.ip ?? '';
  const ccOf = (r: string) => r.match(/^([a-z]{2})-\d/i)?.[1]?.toLowerCase();
  const country =
    target.country?.toLowerCase() ??
    sameExitRemarks.map(ccOf).find(Boolean) ??
    (() => {
      const counts = new Map<string, number>();
      for (const d of all) for (const ib of d.inbounds) {
        const cc = ccOf(String(ib.remark ?? ''));
        if (cc) counts.set(cc, (counts.get(cc) ?? 0) + 1);
      }
      return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'us';
    })();
  const suffix = suffixOf(relay.inbounds) || freeSuffix(relay, all, pausedSuffixes);
  const base = `${country}-${ip}${suffix ? `-${suffix}` : ''}`;
  const taken = new Set(relay.inbounds.map((ib) => String(ib.remark ?? '')));
  let name = base;
  for (let i = 2; taken.has(name); i++) name = `${base}-${i}`;
  return name;
}

interface Planned {
  plan: LinePlan;
  targets: Map<string, { label: string; target: ExitTarget }>;
  templates: Map<number, any>;
  ctx: RouteContext;
}

async function buildPlan(db: DB, customerId: number, adminFor: (panel: Panel) => PanelLineAdmin): Promise<Planned> {
  if (!getCustomer(db, customerId)) throw new InputError('客户不存在');
  const { data, errors, ctx, socks, pausedSuffixes } = await readRelays(db, adminFor);
  const bound = db.prepare('SELECT panel_id, email FROM bindings WHERE customer_id = ?').all(customerId) as { panel_id: number; email: string }[];

  // 每台中转:入站 → 出口
  const routed = data.map((d) => {
    const inbounds = d.inbounds
      .filter((ib) => ib.enable !== false && CLIENT_PROTOCOLS.has(ib.protocol))
      .map((ib) => {
        const emails = d.clients.filter((c) => (c.inboundIds ?? []).map(Number).includes(Number(ib.id))).map((c) => String(c.email));
        const { route, extra } = resolveRoute(d.xray, String(ib.tag ?? ''), emails, ctx);
        return { ib, exit: exitOf(route.kind, route.label), extra };
      })
      .filter((x) => x.exit);
    return { ...d, routed: inbounds };
  });

  const labels = new Map<string, string>();
  for (const r of routed) for (const x of r.routed) labels.set(x.exit!.key, x.exit!.label);
  const targets = exitTargets(db, data, ctx, socks);
  for (const [key, t] of targets) if (!labels.has(key)) labels.set(key, t.label);
  const templates = new Map(routed.map((r) => [r.panel.id, templateOf(r.routed)]));

  const exits = [...labels].map(([key, label]): ExitOption => {
    const sameExitRemarks = routed.flatMap((r) => r.routed.filter((x) => x.exit!.key === key).map((x) => String(x.ib.remark ?? '')));
    return {
      key,
      label,
      relays: routed.map((r): RelayPlan => {
        const ip = exitIp(db, key, r.panel, socks);
        const candidates = r.routed
          .filter((x) => x.exit!.key === key)
          .map((x) => ({ ...x, rank: ip && String(x.ib.remark ?? '').includes(ip) ? 0 : x.extra === 0 ? 1 : 2 }))
          .sort((a, b) => a.rank - b.rank || Number(a.ib.id) - Number(b.ib.id));
        const target = candidates[0]?.ib;
        const ids = new Set(candidates.map((x) => Number(x.ib.id)));
        const mine = bound.filter((b) => b.panel_id === r.panel.id).map((b) => b.email);
        const has = r.clients.find((c) => mine.includes(String(c.email)) && (c.inboundIds ?? []).some((i: unknown) => ids.has(Number(i))));
        const hasInbound = has && r.inbounds.find((ib) => (has.inboundIds ?? []).map(Number).includes(Number(ib.id)) && ids.has(Number(ib.id)));
        const t = targets.get(key)?.target;
        const template = templates.get(r.panel.id);
        return {
          panel_id: r.panel.id,
          panel_name: r.panel.name,
          inbound: target ? { id: Number(target.id), remark: String(target.remark ?? ''), protocol: String(target.protocol), port: Number(target.port) } : null,
          create:
            !target && t && template
              ? { remark: remarkFor(t, r, data, sameExitRemarks, pausedSuffixes), protocol: String(template.protocol), template: String(template.remark ?? '') }
              : null,
          existing: has ? { email: String(has.email), inbound: String(hasInbound?.remark ?? '') } : null,
        };
      }),
    };
  });
  // 已有入站能开的中转多的排前面,只能新建入站的排后面
  const reach = (e: ExitOption) => e.relays.filter((r) => r.inbound).length;
  exits.sort((a, b) => reach(b) - reach(a) || a.label.localeCompare(b.label, 'zh-CN'));
  return { plan: { exits, errors }, targets, templates, ctx };
}

export async function planLines(db: DB, customerId: number, adminFor: (panel: Panel) => PanelLineAdmin): Promise<LinePlan> {
  return (await buildPlan(db, customerId, adminFor)).plan;
}

/** 新 client 的 email:沿用客户线路里最常用的 email(没有就用客户名),重名时加 -2、-3。
 *  面板上已有的、本系统里这台面板上已绑定的(面板上可能已删)都算占用 */
export function emailFor(db: DB, customerId: number, name: string, taken: Set<string>): string {
  const row = db
    .prepare('SELECT email, COUNT(*) n FROM bindings WHERE customer_id = ? GROUP BY email ORDER BY n DESC, MIN(id) LIMIT 1')
    .get(customerId) as { email: string } | undefined;
  const base = (row?.email ?? name).trim().replace(/\s+/g, '-') || 'customer';
  let email = base;
  for (let i = 2; taken.has(email); i++) email = `${base}-${i}`;
  return email;
}

export function newClient(email: string, inbound: any, enable: boolean) {
  const stream = decodeJson(inbound.streamSettings) ?? {};
  const vision = inbound.protocol === 'vless' && stream.network === 'tcp' && (stream.security === 'reality' || stream.security === 'tls');
  const id = randomUUID();
  return {
    id,
    email,
    password: id,
    auth: randomBytes(12).toString('hex'),
    flow: vision ? 'xtls-rprx-vision' : '',
    limitIp: 0,
    totalGB: 0,
    expiryTime: 0,
    enable,
    tgId: 0,
    subId: randomBytes(8).toString('hex'),
    comment: '',
    reset: 0,
  };
}

/** 新入站的端口:20000~59999 里随机挑,避开这台中转已有入站和面板自己用的端口 */
export function pickPort(panel: Panel, inbounds: any[]): number {
  const used = new Set([...inbounds.map((ib) => Number(ib.port)), Number(new URL(panel.base_url).port) || 0, 2096, 2053, 443, 80]);
  for (let i = 0; i < 100; i++) {
    const port = 20000 + Math.floor(Math.random() * 40000);
    if (!used.has(port)) return port;
  }
  throw new Error('挑不到空闲端口');
}

/** 照模板入站复制一份:换端口和名字,清空 client,不带流量和到期;字段的类型(对象 / JSON 字符串)跟模板一致 */
export function cloneInbound(template: any, port: number, remark: string): any {
  const { id: _id, tag: _tag, originNodeGuid: _g, clientStats: _c, up: _u, down: _d, lastTrafficResetTime: _l, allTime: _a, ...rest } = template;
  const settings = { ...(decodeJson(rest.settings) ?? {}), clients: [] };
  return {
    ...rest,
    port,
    remark,
    enable: true,
    total: 0,
    expiryTime: 0,
    settings: typeof rest.settings === 'string' ? JSON.stringify(settings) : settings,
  };
}

/** 中转上指向这个出口的出站:已有(地址、端口一致,SOCKS 账号也一致)就复用,没有就加一个;返回它的 tag */
export function ensureOutbound(xray: any, target: ExitTarget, ctx: RouteContext): string {
  xray.outbounds = Array.isArray(xray.outbounds) ? xray.outbounds : [];
  if (target.kind === 'direct') {
    const direct = xray.outbounds.find((o: any) => o?.protocol === 'freedom');
    if (direct?.tag) return String(direct.tag);
    xray.outbounds.push({ tag: 'direct', protocol: 'freedom' });
    return 'direct';
  }
  const s = target.server!;
  const same = xray.outbounds.find((o: any) => {
    if (o?.protocol !== 'socks') return false;
    const v = serverOf(o);
    const where = target.kind === 'panel' ? ctx.panelHosts.get(v.address) === target.panel || v.address === s.address.toLowerCase() : v.address === s.address.toLowerCase();
    const user = (decodeJson(o.settings)?.servers ?? [])[0]?.users?.[0] ?? {};
    return where && v.port === s.port && String(user.user ?? '') === s.user && String(user.pass ?? '') === s.pass;
  });
  if (same?.tag) return String(same.tag);
  const taken = new Set(xray.outbounds.map((o: any) => String(o?.tag ?? '')));
  const base = `socks-${s.address}-${s.port}`;
  let tag = base;
  for (let i = 2; taken.has(tag); i++) tag = `${base}-${i}`;
  xray.outbounds.push({
    tag,
    protocol: 'socks',
    settings: { servers: [{ address: s.address, port: s.port, users: s.user || s.pass ? [{ user: s.user, pass: s.pass }] : [] }] },
  });
  return tag;
}

/** 默认的端口探测:能连上 = 入站在监听 */
export function tcpOpen(host: string, port: number, timeoutMs = 6000): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect({ host, port });
    const done = (ok: boolean) => {
      s.destroy();
      resolve(ok);
    };
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
    s.setTimeout(timeoutMs, () => done(false));
  });
}

/** 在这台中转上为出口新建入站:存快照 → 照模板建入站 → 补出站和规则(核对路由)→ 重启 Xray → 核对端口在监听。返回新入站 */
async function createInbound(
  db: DB,
  panel: Panel,
  admin: PanelLineAdmin,
  template: any,
  remark: string,
  target: ExitTarget,
  ctx: RouteContext,
  probe: (host: string, port: number) => Promise<boolean>,
): Promise<any> {
  // 改之前存一份,出问题可以在面板详情里按快照恢复
  await takeSnapshot(db, panel, admin);
  const port = pickPort(panel, await admin.listInbounds());
  await admin.addInbound(cloneInbound(template, port, remark));
  const created = (await admin.listInbounds()).find((ib) => Number(ib.port) === port && ib.protocol === template.protocol);
  if (!created?.tag) throw new Error('新建入站后读回没找到');
  try {
    const raw = await admin.xraySettings();
    const xray = xrayConfig(raw);
    if (!Array.isArray(xray.outbounds) || !xray.outbounds.length) throw new Error('读到的 Xray 配置不完整(没有出站)');
    const outTag = ensureOutbound(xray, target, ctx);
    xray.routing = { ...(xray.routing ?? {}), rules: [...(Array.isArray(xray.routing?.rules) ? xray.routing.rules : []), { type: 'field', inboundTag: [String(created.tag)], outboundTag: outTag }] };
    if (resolveRoute(xray, String(created.tag), [], ctx).route.outbound !== outTag) throw new Error('加规则后路由仍没有走到这个出口,没有保存');
    await admin.updateXray(xray, decodeJson(raw)?.outboundTestUrl || DEFAULT_TEST_URL);
  } catch (e) {
    // Xray 配置没改成,新建的入站删掉,面板回到原样
    await admin.deleteInbound(Number(created.id)).catch(() => {});
    throw e;
  }
  await admin.restartXray();
  const network = streamOf(created).network;
  if (created.protocol !== 'hysteria' && network !== 'kcp' && network !== 'quic') {
    const host = panel.ip ?? new URL(panel.base_url).hostname;
    if (!(await probe(host, port))) throw new Error(`新入站 ${port} 端口连不上,可能被占用或防火墙没放行`);
  }
  return created;
}

/** 在选中的中转上开线路(计划里"将新建"的那些);没有入站的先新建入站。每台建完读回核对,成功的绑定到客户 */
export async function openLines(
  db: DB,
  customerId: number,
  exitKey: string,
  panelIds: number[],
  adminFor: (panel: Panel) => PanelLineAdmin,
  now = Date.now(),
  probe: (host: string, port: number) => Promise<boolean> = tcpOpen,
): Promise<OpenLineResult[]> {
  const customer = getCustomer(db, customerId, now);
  if (!customer) throw new InputError('客户不存在');
  const { plan, targets, templates, ctx } = await buildPlan(db, customerId, adminFor);
  const exit = plan.exits.find((e) => e.key === exitKey);
  if (!exit) throw new InputError('找不到这个出口,刷新后再试');
  const wanted = new Set(panelIds.map(Number));
  const todo = exit.relays.filter((r) => wanted.has(r.panel_id) && (r.inbound || r.create) && !r.existing);
  const enable = customer.state === 'active';
  const ensureCounter = db.prepare(
    `INSERT OR IGNORE INTO client_counters (panel_id, email, up, down, comment, enable, total_bytes, expiry_ms, last_online, updated_at)
     VALUES (?, ?, 0, 0, '', ?, 0, 0, 0, ?)`,
  );

  const results = await Promise.all(
    todo.map(async (r): Promise<OpenLineResult> => {
      const panel = listPanels(db).find((p) => p.id === r.panel_id)!;
      const admin = adminFor(panel);
      const result: OpenLineResult = { panel: r.panel_name, inbound: r.inbound?.remark ?? r.create!.remark, email: '', ok: false };
      try {
        let inboundId = r.inbound?.id;
        if (inboundId == null) {
          const created = await createInbound(db, panel, admin, templates.get(panel.id), r.create!.remark, targets.get(exitKey)!.target, ctx, probe);
          inboundId = Number(created.id);
          result.inbound = String(created.remark ?? r.create!.remark);
          result.created = true;
        }
        const [inbounds, clients] = await Promise.all([admin.listInbounds(), admin.listClients()]);
        const inbound = inbounds.find((ib) => Number(ib.id) === inboundId);
        if (!inbound) throw new Error('面板上找不到这个入站');
        const boundHere = (db.prepare('SELECT email FROM bindings WHERE panel_id = ?').all(panel.id) as { email: string }[]).map((b) => b.email);
        result.email = emailFor(db, customerId, customer.name, new Set([...clients.map((c) => String(c.email)), ...boundHere]));
        await admin.addClient(newClient(result.email, inbound, enable), [inboundId]);
        const back = (await admin.listClients()).find((c) => c.email === result.email);
        if (!back || !(back.inboundIds ?? []).map(Number).includes(inboundId)) throw new Error('建完读回没找到,或没挂到入站上');
        // 本地先记一条计数器(新 client 用量为 0),才能绑定;之后的同步照常累计
        ensureCounter.run(panel.id, result.email, enable ? 1 : 0, now);
        addBinding(db, customerId, panel.id, result.email, false, now);
        result.ok = true;
      } catch (e) {
        result.error = e instanceof Error ? e.message : String(e);
      } finally {
        await admin.close?.();
      }
      return result;
    }),
  );
  return results;
}
