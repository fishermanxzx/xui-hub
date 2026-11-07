// 给中转(多半是新加的)批量开线路:勾选客户,按每位客户现在在用的落地(落地机 / SOCKS,从他在其他中转、落地上的线路推算),
// 在这台中转上各开一条通往同一落地的线路。中转本机直出的线路不复制(换了中转,出口 IP 就变了);客户在落地上的直连算作通往那台落地。
// 这台中转上已有通往它的入站就复用;没有就新建:照这台中转的同类入站,空中转照别的中转的 vless reality 入站、换新密钥。
// 一次建好所有要新建的入站,再一起补出站和规则、只重启一次 Xray;改之前先存配置快照,Xray 配置保存失败就删掉刚建的入站。

import type { DB } from '../db';
import { resolveRoute, type RouteContext } from '../panels/inbounds';
import { getPanel, InputError, type Panel } from '../panels/repo';
import { DEFAULT_TEST_URL, loadSnapshot, takeSnapshot, type SnapshotData } from '../panels/snapshots';
import { decodeJson, xrayConfig } from '../xui/json';
import { freshReality } from './directLines';
import {
  CLIENT_PROTOCOLS,
  cloneInbound,
  emailFor,
  ensureOutbound,
  exitIp,
  exitOf,
  exitTargets,
  newClient,
  pickPort,
  readRelays,
  remarkFor,
  streamOf,
  tcpOpen,
  templateOf,
  type ExitTarget,
  type PanelLineAdmin,
  type RelayData,
} from './openLines';
import { addBinding, getCustomer } from './repo';

export interface RelayExitPlan {
  key: string;
  label: string;
  /** reuse 复用已有入站;create 新建入站;existing 客户在这台中转上已有;unsupported 开不了 */
  status: 'reuse' | 'create' | 'existing' | 'unsupported';
  /** 复用 / 新建的入站名,已有时是客户的 client email */
  inbound?: string;
  reason?: string;
}

export interface RelayCustomerPlan {
  id: number;
  name: string;
  state: string;
  exits: RelayExitPlan[];
}

export interface RelayLinesPlan {
  relay: { id: number; name: string };
  /** 新建入站照着哪个来(空中转时是别的中转的入站) */
  template: string | null;
  customers: RelayCustomerPlan[];
  errors: { panel: string; error: string }[];
}

export interface RelayLineResult {
  customer: string;
  exit: string;
  inbound: string;
  email: string;
  ok: boolean;
  /** 这条线路用的是这次新建的入站 */
  created?: boolean;
  error?: string;
}

interface Built {
  plan: RelayLinesPlan;
  relay: Panel;
  me: RelayData;
  template: any | null;
  targets: Map<string, { label: string; target: ExitTarget }>;
  /** 每个出口在这台中转上复用的入站 id */
  reuse: Map<string, number>;
  /** 要新建的出口 → 入站名 */
  create: Map<string, string>;
  ctx: RouteContext;
}

function relayOf(db: DB, id: number): Panel {
  const panel = getPanel(db, id);
  if (!panel) throw new InputError('面板不存在');
  if (panel.role !== 'relay') throw new InputError('批量开线路只用于中转');
  return panel;
}

function routedOf(d: RelayData, ctx: RouteContext) {
  return d.inbounds
    .filter((ib) => ib.enable !== false && CLIENT_PROTOCOLS.has(ib.protocol))
    .map((ib) => {
      const emails = d.clients.filter((c) => (c.inboundIds ?? []).map(Number).includes(Number(ib.id))).map((c) => String(c.email));
      const { route, extra } = resolveRoute(d.xray, String(ib.tag ?? ''), emails, ctx);
      return { ib, exit: exitOf(route.kind, route.label), extra };
    })
    .filter((x) => x.exit);
}

/** 新建入站照着哪个:这台中转的同类入站;空中转用别的中转上最常见的 vless reality 入站,换新密钥 */
function relayTemplate(me: RelayData, others: RelayData[], ctx: RouteContext): { ib: any; from: string } | null {
  const own = templateOf(routedOf(me, ctx));
  if (own) return { ib: own, from: String(own.remark || `${own.protocol}:${own.port}`) };
  for (const d of others) {
    const ib = d.inbounds.find((x) => x.protocol === 'vless' && streamOf(x).network === 'tcp' && streamOf(x).security === 'reality');
    if (ib) return { ib: freshReality(ib), from: `${d.panel.name} 的 ${ib.remark || ib.port}` };
  }
  return null;
}

/** 每位客户在用的落地(出口 key → 名字):按其他中转、落地的最近配置快照里他 client 挂的入站的路由推算 */
function customerExits(db: DB, relayId: number, ctx: RouteContext): Map<number, Map<string, string>> {
  const rows = db
    .prepare(
      `SELECT b.customer_id, b.panel_id, b.email, p.role, p.name FROM bindings b JOIN panels p ON p.id = b.panel_id
       WHERE b.panel_id != ? AND p.enabled = 1`,
    )
    .all(relayId) as { customer_id: number; panel_id: number; email: string; role: string; name: string }[];
  const snaps = new Map<number, SnapshotData | null>();
  const snapOf = (panelId: number) => {
    if (!snaps.has(panelId)) {
      const row = db.prepare('SELECT id FROM panel_snapshots WHERE panel_id = ? ORDER BY taken_at DESC, id DESC LIMIT 1').get(panelId) as { id: number } | undefined;
      snaps.set(panelId, row ? loadSnapshot(db, panelId, row.id) : null);
    }
    return snaps.get(panelId)!;
  };
  const out = new Map<number, Map<string, string>>();
  for (const r of rows) {
    const snap = snapOf(r.panel_id);
    const client = snap?.clients.find((c) => String(c.client?.email) === r.email);
    if (!snap || !client) continue;
    for (const ib of snap.inbounds.filter((i) => client.inboundIds.includes(Number(i.id)))) {
      const { route } = resolveRoute(snap.xray, String(ib.tag ?? ''), [r.email], ctx);
      const key = route.kind === 'panel' || route.kind === 'socks' ? `${route.kind}:${route.label}` : route.kind === 'direct' && r.role !== 'relay' ? `panel:${r.name}` : null;
      if (!key) continue;
      const exits = out.get(r.customer_id) ?? new Map<string, string>();
      exits.set(key, route.kind === 'direct' ? r.name : route.label);
      out.set(r.customer_id, exits);
    }
  }
  return out;
}

async function build(db: DB, relayId: number, adminFor: (panel: Panel) => PanelLineAdmin): Promise<Built> {
  const relay = relayOf(db, relayId);
  const { data, errors, ctx, socks, pausedSuffixes } = await readRelays(db, adminFor);
  const me = data.find((d) => d.panel.id === relay.id);
  if (!me) throw new InputError(`读不到这台中转:${errors.find((e) => e.panel === relay.name)?.error ?? '连不上'}`);
  const others = data.filter((d) => d.panel.id !== relay.id);
  const routed = routedOf(me, ctx);
  const sameExit = (key: string) => data.flatMap((d) => routedOf(d, ctx).filter((x) => x.exit!.key === key).map((x) => String(x.ib.remark ?? '')));
  const targets = exitTargets(db, data, ctx, socks);
  const t = relayTemplate(me, others, ctx);
  const exitsOf = customerExits(db, relay.id, ctx);

  // 客户在这台中转上已有的线路:email → 通往的出口
  const bound = db.prepare('SELECT customer_id, email FROM bindings WHERE panel_id = ?').all(relay.id) as { customer_id: number; email: string }[];
  const reuse = new Map<string, number>();
  const create = new Map<string, string>();
  const reuseName = new Map<string, string>();
  const customers: RelayCustomerPlan[] = [];
  const ids = [...new Set([...exitsOf.keys(), ...bound.map((b) => b.customer_id)])];
  for (const id of ids) {
    const c = getCustomer(db, id);
    if (!c) continue;
    const mine = bound.filter((b) => b.customer_id === id).map((b) => b.email);
    const plan: RelayCustomerPlan = { id, name: c.name, state: c.state, exits: [] };
    for (const [key, label] of exitsOf.get(id) ?? []) {
      const candidates = routed.filter((x) => x.exit!.key === key);
      const ids2 = new Set(candidates.map((x) => Number(x.ib.id)));
      const has = me.clients.find((x) => mine.includes(String(x.email)) && (x.inboundIds ?? []).some((i: unknown) => ids2.has(Number(i))));
      if (has) {
        plan.exits.push({ key, label, status: 'existing', inbound: String(has.email) });
        continue;
      }
      if (candidates.length) {
        if (!reuse.has(key)) {
          const ip = exitIp(db, key, relay, socks);
          const best = candidates
            .map((x) => ({ ...x, rank: ip && String(x.ib.remark ?? '').includes(ip) ? 0 : x.extra === 0 ? 1 : 2 }))
            .sort((a, b) => a.rank - b.rank || Number(a.ib.id) - Number(b.ib.id))[0].ib;
          reuse.set(key, Number(best.id));
          reuseName.set(key, String(best.remark ?? ''));
        }
        plan.exits.push({ key, label, status: 'reuse', inbound: reuseName.get(key) });
        continue;
      }
      const target = targets.get(key)?.target;
      if (!target) {
        plan.exits.push({ key, label, status: 'unsupported', reason: key.startsWith('panel:') ? '这台落地上没有给中转用的 mixed / socks 入站' : '这个 SOCKS 没有登记' });
        continue;
      }
      if (!t) {
        plan.exits.push({ key, label, status: 'unsupported', reason: '找不到可以照着建的入站' });
        continue;
      }
      if (!create.has(key)) create.set(key, remarkFor(target, me, data, sameExit(key), pausedSuffixes));
      plan.exits.push({ key, label, status: 'create', inbound: create.get(key) });
    }
    // 只用中转本机直出的客户没有能复制过来的落地,不列
    if (plan.exits.length) customers.push(plan);
  }
  customers.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  return {
    plan: { relay: { id: relay.id, name: relay.name }, template: t?.from ?? null, customers, errors },
    relay,
    me,
    template: t?.ib ?? null,
    targets,
    reuse,
    create,
    ctx,
  };
}

export async function planRelayLines(db: DB, relayId: number, adminFor: (panel: Panel) => PanelLineAdmin): Promise<RelayLinesPlan> {
  return (await build(db, relayId, adminFor)).plan;
}

/** 一次建好要新建的入站:存快照 → 逐个建 → 一起补出站和规则(核对路由)→ 只重启一次 → 核对端口。返回出口 → 入站;端口不通的记在 failed */
async function createInbounds(
  db: DB,
  relay: Panel,
  admin: PanelLineAdmin,
  template: any,
  wants: { key: string; remark: string; target: ExitTarget }[],
  ctx: RouteContext,
  probe: (host: string, port: number) => Promise<boolean>,
): Promise<{ created: Map<string, any>; failed: Map<string, string> }> {
  await takeSnapshot(db, relay, admin);
  const created = new Map<string, any>();
  try {
    for (const w of wants) {
      const port = pickPort(relay, await admin.listInbounds());
      await admin.addInbound(cloneInbound(template, port, w.remark));
      const ib = (await admin.listInbounds()).find((x) => Number(x.port) === port && x.protocol === template.protocol);
      if (!ib?.tag) throw new Error(`新建入站 ${w.remark} 后读回没找到`);
      created.set(w.key, ib);
    }
    const raw = await admin.xraySettings();
    const xray = xrayConfig(raw);
    if (!Array.isArray(xray.outbounds) || !xray.outbounds.length) throw new Error('读到的 Xray 配置不完整(没有出站)');
    const rules = Array.isArray(xray.routing?.rules) ? [...xray.routing.rules] : [];
    const outs = new Map<string, string>();
    for (const w of wants) {
      const out = ensureOutbound(xray, w.target, ctx);
      outs.set(w.key, out);
      rules.push({ type: 'field', inboundTag: [String(created.get(w.key).tag)], outboundTag: out });
    }
    xray.routing = { ...(xray.routing ?? {}), rules };
    for (const w of wants) {
      if (resolveRoute(xray, String(created.get(w.key).tag), [], ctx).route.outbound !== outs.get(w.key)) throw new Error(`加规则后 ${w.remark} 的路由没有走到 ${w.target.ip ?? w.key},没有保存`);
    }
    await admin.updateXray(xray, decodeJson(raw)?.outboundTestUrl || DEFAULT_TEST_URL);
  } catch (e) {
    for (const ib of created.values()) await admin.deleteInbound(Number(ib.id)).catch(() => {});
    throw e;
  }
  await admin.restartXray();
  const failed = new Map<string, string>();
  const host = relay.ip ?? new URL(relay.base_url).hostname;
  for (const [key, ib] of created) {
    const network = streamOf(ib).network;
    if (ib.protocol === 'hysteria' || network === 'kcp' || network === 'quic') continue;
    if (!(await probe(host, Number(ib.port)))) failed.set(key, `新入站 ${ib.port} 端口连不上,可能被占用或防火墙没放行`);
  }
  return { created, failed };
}

/** 给勾选的客户在这台中转上按各自的落地开线路;缺的入站先一次建好。逐条建 client,读回核对,成功的绑定到客户 */
export async function openRelayLines(
  db: DB,
  relayId: number,
  customerIds: number[],
  adminFor: (panel: Panel) => PanelLineAdmin,
  now = Date.now(),
  probe: (host: string, port: number) => Promise<boolean> = tcpOpen,
): Promise<{ created: string[]; results: RelayLineResult[] }> {
  const b = await build(db, relayId, adminFor);
  const wanted = new Set(customerIds.map(Number));
  const lines = b.plan.customers
    .filter((c) => wanted.has(c.id))
    .flatMap((c) => c.exits.filter((e) => e.status === 'reuse' || e.status === 'create').map((e) => ({ c, e })));
  if (!lines.length) return { created: [], results: [] };

  const admin = adminFor(b.relay);
  const results: RelayLineResult[] = [];
  const createdNames: string[] = [];
  try {
    const inboundOf = new Map(b.reuse);
    const failed = new Map<string, string>();
    const wants = [...new Set(lines.filter((l) => l.e.status === 'create').map((l) => l.e.key))].map((key) => ({ key, remark: b.create.get(key)!, target: b.targets.get(key)!.target }));
    if (wants.length) {
      try {
        const out = await createInbounds(db, b.relay, admin, b.template, wants, b.ctx, probe);
        for (const [key, ib] of out.created) {
          inboundOf.set(key, Number(ib.id));
          createdNames.push(String(ib.remark ?? ''));
        }
        for (const [key, why] of out.failed) failed.set(key, why);
      } catch (e) {
        for (const w of wants) failed.set(w.key, e instanceof Error ? e.message : String(e));
      }
    }
    const inbounds = await admin.listInbounds();
    const boundHere = (db.prepare('SELECT email FROM bindings WHERE panel_id = ?').all(b.relay.id) as { email: string }[]).map((x) => x.email);
    const taken = new Set([...(await admin.listClients()).map((c) => String(c.email)), ...boundHere]);
    // 同一台面板上逐条建,email 去重才准
    for (const { c, e } of lines) {
      const result: RelayLineResult = { customer: c.name, exit: e.label, inbound: e.inbound ?? '', email: '', ok: false, ...(e.status === 'create' ? { created: true } : {}) };
      results.push(result);
      const why = failed.get(e.key);
      const id = inboundOf.get(e.key);
      const inbound = inbounds.find((ib) => Number(ib.id) === id);
      if (why || !inbound) {
        result.error = why ?? '面板上找不到这个入站';
        continue;
      }
      const customer = getCustomer(db, c.id, now)!;
      result.email = emailFor(db, c.id, customer.name, taken);
      taken.add(result.email);
      try {
        const enable = customer.state === 'active';
        await admin.addClient(newClient(result.email, inbound, enable), [Number(inbound.id)]);
        const back = (await admin.listClients()).find((x) => x.email === result.email);
        if (!back || !(back.inboundIds ?? []).map(Number).includes(Number(inbound.id))) throw new Error('建完读回没找到,或没挂到入站上');
        db.prepare(
          `INSERT OR IGNORE INTO client_counters (panel_id, email, up, down, comment, enable, total_bytes, expiry_ms, last_online, updated_at)
           VALUES (?, ?, 0, 0, '', ?, 0, 0, 0, ?)`,
        ).run(b.relay.id, result.email, enable ? 1 : 0, now);
        addBinding(db, c.id, b.relay.id, result.email, false, now);
        result.ok = true;
      } catch (err) {
        result.error = err instanceof Error ? err.message : String(err);
      }
    }
  } finally {
    await admin.close?.();
  }
  return { created: createdNames, results };
}
