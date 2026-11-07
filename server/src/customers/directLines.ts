// 给落地机开直连:出口经过这台落地的客户(按各线路的落地 IP 推算),在落地机上直接开一条线路,
// 客户端直连落地、不走中转。只用于落地机(中转不行)。协议可选 vless(reality)或 hy2。
// 落地上已有这个协议、直出的入站就复用(vless 优先 reality;都优先已有 client 多的);没有就新建:
// - vless:这台落地上有 reality 入站就照它复制,否则照别的面板上 reality 入站的伪装设置,密钥和 shortId 重新生成;
// - hy2:这台落地上有 hy2 入站就照它复制,否则照别的面板上 hy2 入站的结构,证书换成这台面板自己用的那份、混淆密码重新生成。
// 新入站走默认出站;默认出站不是直连时补一条到直连出站的规则并重启 Xray。改之前先存配置快照。
// 客户已在这台落地上有别的协议的线路时,把他现有的 client 挂到新协议的入站上,不另建 client。

import { generateKeyPairSync, randomBytes } from 'node:crypto';
import type { DB } from '../db';
import { exitKey, lineExits } from '../panels/exits';
import { addDomainHosts, panelHosts } from '../panels/hosts';
import { resolveRoute, type RouteContext } from '../panels/inbounds';
import { getPanel, InputError, listPanels, type Panel } from '../panels/repo';
import { DEFAULT_TEST_URL, loadSnapshot, takeSnapshot } from '../panels/snapshots';
import { decodeJson, xrayConfig } from '../xui/json';
import { cloneInbound, emailFor, newClient, pickPort, tcpOpen, type PanelLineAdmin } from './openLines';
import { addBinding, getCustomer } from './repo';

export type DirectProtocol = 'vless' | 'hysteria';

export interface DirectAdmin extends PanelLineAdmin {
  attachClient(email: string, inboundIds: number[]): Promise<void>;
  /** 面板自己用的证书路径(新建 hy2 入站用) */
  panelCert(): Promise<{ certFile: string; keyFile: string }>;
}

export interface DirectPlan {
  panel: { id: number; name: string; ip: string };
  protocol: DirectProtocol;
  /** 复用的入站 */
  inbound: { id: number; remark: string; port: number; clients: number } | null;
  /** 没有可复用的入站时新建:名字、照着哪个入站建、要不要重启 Xray */
  create: { remark: string; template: string; restart: boolean } | null;
  /** 开不了的原因 */
  error?: string;
  /** 出口经过这台落地的客户;existing = 已有这个协议的线路;attach = 已有别的协议的 client,会挂到新入站上 */
  customers: { id: number; name: string; state: string; lines: number; existing: string | null; attach: string | null }[];
}

export interface DirectResult {
  customer: string;
  email: string;
  ok: boolean;
  /** 挂到了已有的 client 上(没另建) */
  attached?: boolean;
  error?: string;
}

const streamOf = (ib: any) => decodeJson(ib.streamSettings) ?? {};
const isReality = (ib: any) => ib.protocol === 'vless' && streamOf(ib).network === 'tcp' && streamOf(ib).security === 'reality';
const isTemplate = (protocol: DirectProtocol) => (ib: any) => (protocol === 'vless' ? isReality(ib) : ib.protocol === 'hysteria' && streamOf(ib).security === 'tls');
const label = (protocol: DirectProtocol) => (protocol === 'vless' ? 'vless' : 'hy2');

function landingOf(db: DB, panelId: number): Panel & { ip: string } {
  const panel = getPanel(db, panelId);
  if (!panel) throw new InputError('面板不存在');
  if (panel.role === 'relay') throw new InputError('开直连只用于落地机');
  if (!panel.ip) throw new InputError('这台落地没有填 IP');
  return panel as Panel & { ip: string };
}

function protocolOf(value: unknown): DirectProtocol {
  if (value === undefined || value === 'vless') return 'vless';
  if (value === 'hysteria' || value === 'hy2' || value === 'hysteria2') return 'hysteria';
  throw new InputError('协议只能是 vless 或 hy2');
}

async function contextFor(db: DB, xray: any): Promise<RouteContext> {
  const hosts = await panelHosts(listPanels(db));
  const addrs = (Array.isArray(xray.outbounds) ? xray.outbounds : []).map((o: any) => String(((decodeJson(o?.settings)?.servers ?? decodeJson(o?.settings)?.vnext ?? [])[0] ?? {}).address ?? ''));
  await addDomainHosts(addrs, hosts);
  const socks = db.prepare('SELECT name, host, port FROM socks_proxies').all() as { name: string; host: string; port: number }[];
  return { panelHosts: hosts, socks: socks.map((s) => ({ name: s.name, host: s.host.toLowerCase(), port: s.port })) };
}

const onInbound = (c: any, ib: any) => (c.inboundIds ?? []).map(Number).includes(Number(ib.id));

/** 能复用的入站:启用的、这个协议的、路由是本机直出;vless 优先 reality,都优先 client 多的 */
function reusable(protocol: DirectProtocol, inbounds: any[], clients: any[], xray: any, ctx: RouteContext) {
  return inbounds
    .filter((ib) => ib.protocol === protocol && ib.enable !== false && ib.tag)
    .filter((ib) => resolveRoute(xray, String(ib.tag), [], ctx).route.kind === 'direct')
    .map((ib) => ({ ib, clients: clients.filter((c) => onInbound(c, ib)).length }))
    .sort((a, b) => Number(isReality(b.ib)) - Number(isReality(a.ib)) || b.clients - a.clients || Number(a.ib.id) - Number(b.ib.id))[0];
}

/** 新建时照着哪个入站:本机同协议的优先(密钥 / 证书可沿用),否则别的面板最近快照里的(落地优先,要换密钥 / 证书) */
function templateFor(db: DB, panel: Panel, protocol: DirectProtocol, inbounds: any[]): { ib: any; remote: boolean; from: string } | null {
  const own = inbounds.find(isTemplate(protocol));
  if (own) return { ib: own, remote: false, from: String(own.remark || `${own.protocol}:${own.port}`) };
  const others = listPanels(db)
    .filter((p) => p.id !== panel.id)
    .sort((a, b) => Number(a.role === 'relay') - Number(b.role === 'relay') || a.id - b.id);
  for (const p of others) {
    const row = db.prepare('SELECT id FROM panel_snapshots WHERE panel_id = ? ORDER BY taken_at DESC, id DESC LIMIT 1').get(p.id) as { id: number } | undefined;
    if (!row) continue;
    const ib = loadSnapshot(db, p.id, row.id).inbounds.find(isTemplate(protocol));
    if (ib) return { ib, remote: true, from: `${p.name} 的 ${ib.remark || ib.port}` };
  }
  return null;
}

/** 新入站的名字 <国家>-<IP>-direct(hy2 再加 -hy2),和中转上通往这台落地的入站(如 us-1.2.3.4、us-1.2.3.4-a)区分开;
 *  国家取那些入站名里的,否则 us */
function remarkFor(db: DB, panel: Panel & { ip: string }, protocol: DirectProtocol, inbounds: any[]): string {
  let country = 'us';
  for (const p of listPanels(db).filter((x) => x.id !== panel.id)) {
    const row = db.prepare('SELECT id FROM panel_snapshots WHERE panel_id = ? ORDER BY taken_at DESC, id DESC LIMIT 1').get(p.id) as { id: number } | undefined;
    const hit = row && loadSnapshot(db, p.id, row.id).inbounds.map((ib) => String(ib.remark ?? '').match(/^([a-z]{2})-([\d.]+)/i)).find((m) => m?.[2] === panel.ip);
    if (hit) {
      country = hit[1].toLowerCase();
      break;
    }
  }
  const taken = new Set(inbounds.map((ib) => String(ib.remark ?? '')));
  const base = `${country}-${panel.ip}-direct${protocol === 'hysteria' ? '-hy2' : ''}`;
  let name = base;
  for (let i = 2; taken.has(name); i++) name = `${base}-${i}`;
  return name;
}

const withStream = (template: any, stream: any) => ({
  ...template,
  streamSettings: typeof template.streamSettings === 'string' ? JSON.stringify(stream) : stream,
  shareAddr: '',
});

/** 别的机器上的 reality 入站当模板时,换上新密钥、新 shortId 和 spiderX */
export function freshReality(template: any): any {
  const stream = structuredClone(streamOf(template));
  const { privateKey, publicKey } = generateKeyPairSync('x25519');
  const reality = stream.realitySettings ?? {};
  reality.privateKey = privateKey.export({ format: 'jwk' }).d!;
  reality.shortIds = [2, 4, 6, 8, 10, 12, 14, 16].map((n) => randomBytes(n / 2).toString('hex'));
  reality.mldsa65Seed = '';
  reality.settings = { ...(reality.settings ?? {}), publicKey: publicKey.export({ format: 'jwk' }).x!, spiderX: `/${randomBytes(12).toString('base64url')}`, mldsa65Verify: '' };
  stream.realitySettings = reality;
  return withStream(template, stream);
}

/** 别的机器上的 hy2 入站当模板时,证书换成这台面板自己用的那份(IP 证书只有几天,定期重新读),
 *  SNI 填面板地址(面板证书就是签给它的;SNI 空着时 Xray 内核的客户端连不上),混淆密码重新生成 */
function freshHysteria(template: any, cert: { certFile: string; keyFile: string }, serverName: string): any {
  const stream = structuredClone(streamOf(template));
  stream.tlsSettings = {
    ...(stream.tlsSettings ?? {}),
    serverName,
    certificates: [{ certificateFile: cert.certFile, keyFile: cert.keyFile, ocspStapling: 3600, oneTimeLoading: false, usage: 'encipherment', buildChain: false }],
  };
  for (const m of stream.finalmask?.udp ?? []) {
    if (m?.type === 'salamander') m.settings = { ...(m.settings ?? {}), password: randomBytes(12).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g, 'x') };
  }
  return withStream(template, stream);
}

/** 客户端直连落地的入站:新入站按默认出站走,不是直连就补规则 */
function needsRule(xray: any, ctx: RouteContext): boolean {
  return resolveRoute(xray, '__new_direct_inbound__', [], ctx).route.kind !== 'direct';
}

/** 出口经过这台落地(或本来就在这台落地上有线路)的客户,带上他们在这台落地上的 client email */
async function relatedCustomers(db: DB, panel: Panel & { ip: string }) {
  const exits = await lineExits(db);
  const rows = db
    .prepare('SELECT b.customer_id, b.panel_id, b.email FROM bindings b JOIN customers c ON c.id = b.customer_id ORDER BY c.name COLLATE NOCASE')
    .all() as { customer_id: number; panel_id: number; email: string }[];
  const out = new Map<number, { id: number; name: string; state: string; lines: number; here: string[] }>();
  for (const r of rows) {
    const here = r.panel_id === panel.id;
    const via = (exits.get(exitKey(r.panel_id, r.email)) ?? []).some((e) => e.ip === panel.ip);
    if (!here && !via) continue;
    const c =
      out.get(r.customer_id) ??
      (() => {
        const cust = getCustomer(db, r.customer_id)!;
        return { id: cust.id, name: cust.name, state: cust.state, lines: 0, here: [] as string[] };
      })();
    c.lines++;
    if (here) c.here.push(r.email);
    out.set(r.customer_id, c);
  }
  return [...out.values()];
}

export async function planDirect(db: DB, panelId: number, adminFor: (panel: Panel) => DirectAdmin, protocolValue?: unknown): Promise<DirectPlan> {
  const panel = landingOf(db, panelId);
  const protocol = protocolOf(protocolValue);
  const related = await relatedCustomers(db, panel);
  const plan: DirectPlan = {
    panel: { id: panel.id, name: panel.name, ip: panel.ip },
    protocol,
    inbound: null,
    create: null,
    customers: related.map((c) => ({ id: c.id, name: c.name, state: c.state, lines: c.lines, existing: null, attach: c.here[0] ?? null })),
  };
  const admin = adminFor(panel);
  try {
    const [inbounds, clients, raw] = await Promise.all([admin.listInbounds(), admin.listClients(), admin.xraySettings()]);
    const xray = xrayConfig(raw);
    const ctx = await contextFor(db, xray);
    // 已有这个协议的线路 / 已有别的协议的 client(挂过去)
    const ofProtocol = new Set(inbounds.filter((ib) => ib.protocol === protocol).map((ib) => Number(ib.id)));
    for (const [i, c] of related.entries()) {
      const mine = clients.filter((x) => c.here.includes(String(x.email)));
      const has = mine.find((x) => (x.inboundIds ?? []).some((id: unknown) => ofProtocol.has(Number(id))));
      plan.customers[i].existing = has ? String(has.email) : null;
      plan.customers[i].attach = has ? null : mine[0] ? String(mine[0].email) : null;
    }
    const hit = reusable(protocol, inbounds, clients, xray, ctx);
    if (hit) {
      plan.inbound = { id: Number(hit.ib.id), remark: String(hit.ib.remark ?? ''), port: Number(hit.ib.port), clients: hit.clients };
    } else {
      const t = templateFor(db, panel, protocol, inbounds);
      if (!t) plan.error = `这台落地上没有可复用的直出 ${label(protocol)} 入站,也找不到可以照着建的`;
      else if (protocol === 'hysteria' && t.remote && !(await admin.panelCert()).certFile) plan.error = '这台落地的面板没有配置证书,建不了 hy2 入站(先在面板上申请证书)';
      else plan.create = { remark: remarkFor(db, panel, protocol, inbounds), template: t.from, restart: needsRule(xray, ctx) };
    }
  } catch (e) {
    plan.error = `读不到这台落地:${e instanceof Error ? e.message : String(e)}`;
  } finally {
    await admin.close?.();
  }
  return plan;
}

/** 新建直连入站:存快照 → 照模板建 → 默认出站不是直连就补规则并重启 → vless 核对端口在监听(hy2 走 UDP,探不了) */
async function createInbound(
  db: DB,
  panel: Panel & { ip: string },
  protocol: DirectProtocol,
  admin: DirectAdmin,
  probe: (host: string, port: number) => Promise<boolean>,
): Promise<any> {
  await takeSnapshot(db, panel, admin);
  const inbounds = await admin.listInbounds();
  const t = templateFor(db, panel, protocol, inbounds);
  if (!t) throw new Error('找不到可以照着建的入站');
  let source = t.ib;
  if (t.remote && protocol === 'vless') source = freshReality(t.ib);
  if (t.remote && protocol === 'hysteria') {
    const cert = await admin.panelCert();
    if (!cert.certFile || !cert.keyFile) throw new Error('这台落地的面板没有配置证书,建不了 hy2 入站');
    source = freshHysteria(t.ib, cert, new URL(panel.base_url).hostname);
  }
  const port = pickPort(panel, inbounds);
  await admin.addInbound(cloneInbound(source, port, remarkFor(db, panel, protocol, inbounds)));
  const created = (await admin.listInbounds()).find((ib) => Number(ib.port) === port && ib.protocol === protocol);
  if (!created?.tag) throw new Error('新建入站后读回没找到');
  const raw = await admin.xraySettings();
  const xray = xrayConfig(raw);
  const ctx = await contextFor(db, xray);
  if (resolveRoute(xray, String(created.tag), [], ctx).route.kind !== 'direct') {
    try {
      let direct = xray.outbounds.find((o: any) => o?.protocol === 'freedom');
      if (!direct) xray.outbounds.push((direct = { tag: 'direct', protocol: 'freedom' }));
      xray.routing = { ...(xray.routing ?? {}), rules: [...(xray.routing?.rules ?? []), { type: 'field', inboundTag: [String(created.tag)], outboundTag: direct.tag }] };
      if (resolveRoute(xray, String(created.tag), [], ctx).route.kind !== 'direct') throw new Error('加规则后路由仍不是本机直出,没有保存');
      await admin.updateXray(xray, decodeJson(raw)?.outboundTestUrl || DEFAULT_TEST_URL);
    } catch (e) {
      await admin.deleteInbound(Number(created.id)).catch(() => {});
      throw e;
    }
    await admin.restartXray();
  }
  if (protocol === 'vless' && !(await probe(panel.ip, port))) throw new Error(`新入站 ${port} 端口连不上,可能被占用或防火墙没放行`);
  return created;
}

/** 给选中的客户在落地上开直连;没有可复用的入站先新建一个。已有别的协议 client 的挂过去,其余新建 client 并绑定 */
export async function openDirect(
  db: DB,
  panelId: number,
  customerIds: number[],
  adminFor: (panel: Panel) => DirectAdmin,
  protocolValue?: unknown,
  now = Date.now(),
  probe: (host: string, port: number) => Promise<boolean> = tcpOpen,
): Promise<{ created: string | null; results: DirectResult[] }> {
  const panel = landingOf(db, panelId);
  const protocol = protocolOf(protocolValue);
  const plan = await planDirect(db, panelId, adminFor, protocol);
  if (plan.error) throw new InputError(plan.error);
  const wanted = new Set(customerIds.map(Number));
  const todo = plan.customers.filter((c) => wanted.has(c.id) && !c.existing);
  if (!todo.length) return { created: null, results: [] };

  const admin = adminFor(panel);
  const ensureCounter = db.prepare(
    `INSERT OR IGNORE INTO client_counters (panel_id, email, up, down, comment, enable, total_bytes, expiry_ms, last_online, updated_at)
     VALUES (?, ?, 0, 0, '', ?, 0, 0, 0, ?)`,
  );
  const results: DirectResult[] = [];
  let created: string | null = null;
  try {
    let inboundId = plan.inbound?.id;
    if (inboundId == null) {
      const ib = await createInbound(db, panel, protocol, admin, probe);
      inboundId = Number(ib.id);
      created = String(ib.remark ?? '');
    }
    const inbound = (await admin.listInbounds()).find((ib) => Number(ib.id) === inboundId);
    if (!inbound) throw new Error('面板上找不到这个入站');
    const boundHere = (db.prepare('SELECT email FROM bindings WHERE panel_id = ?').all(panel.id) as { email: string }[]).map((b) => b.email);
    const taken = new Set([...(await admin.listClients()).map((c) => String(c.email)), ...boundHere]);
    // 同一台面板上逐个处理,email 去重才准
    for (const c of todo) {
      const customer = getCustomer(db, c.id, now)!;
      const result: DirectResult = { customer: customer.name, email: c.attach ?? emailFor(db, c.id, customer.name, taken), ok: false };
      taken.add(result.email);
      try {
        if (c.attach) {
          await admin.attachClient(c.attach, [inboundId]);
          result.attached = true;
        } else {
          await admin.addClient(newClient(result.email, inbound, customer.state === 'active'), [inboundId]);
        }
        const back = (await admin.listClients()).find((x) => x.email === result.email);
        if (!back || !(back.inboundIds ?? []).map(Number).includes(inboundId)) throw new Error('读回没找到,或没挂到入站上');
        if (!c.attach) {
          ensureCounter.run(panel.id, result.email, customer.state === 'active' ? 1 : 0, now);
          addBinding(db, c.id, panel.id, result.email, false, now);
        }
        result.ok = true;
      } catch (e) {
        result.error = e instanceof Error ? e.message : String(e);
      }
      results.push(result);
    }
  } catch (e) {
    // 入站没建成:每位客户都记同一个原因
    const error = e instanceof Error ? e.message : String(e);
    for (const c of todo.slice(results.length)) results.push({ customer: c.name, email: '', ok: false, error });
  } finally {
    await admin.close?.();
  }
  return { created, results };
}
