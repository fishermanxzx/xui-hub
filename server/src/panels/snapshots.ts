// 面板配置快照:每小时读一遍各面板的入站、client(Xray 格式,含凭据)和 Xray 模板,有变化才存一份(gzip)。
// 面板重装或配置被误删后,按快照把缺的入站和 client 补回去,并可把 Xray 模板(路由、出站)换回快照里的。
// 恢复只补缺的,不删、不改面板上现有的入站和 client。快照内容只在服务端,接口只给数量和恢复计划。

import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { DB } from '../db';
import { mapLimit } from '../sync/service';
import { decodeJson, xrayConfig } from '../xui/json';
import { InputError, listPanels, type Panel } from './repo';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
/** 每台面板至少留最近几份,不论多旧:面板长期连不上、或重装后又存了几份新的时,出事前的配置还在 */
export const KEEP_LATEST = 10;
export const DEFAULT_TEST_URL = 'https://www.google.com/generate_204';

export interface SnapshotData {
  /** /inbounds/list 的入站,去掉流量统计,settings 里的 client 列表清空(以 clients 为准) */
  inbounds: any[];
  /** /clients/export:Xray 格式的 client 和所挂入站的 id(快照时面板上的 id) */
  clients: { client: any; inboundIds: number[] }[];
  /** Xray 模板 */
  xray: any;
  testUrl: string;
}

export interface SnapshotReader {
  listInbounds(): Promise<any[]>;
  exportClients(): Promise<any[]>;
  xraySettings(): Promise<unknown>;
  close?(): Promise<void>;
}

export interface PanelRestorer extends SnapshotReader {
  addInbound(body: unknown): Promise<void>;
  addClient(client: unknown, inboundIds: number[]): Promise<void>;
  attachClient(email: string, inboundIds: number[]): Promise<void>;
  updateXray(xray: unknown, testUrl: string): Promise<void>;
  restartXray(): Promise<void>;
}

export interface SnapshotView {
  id: number;
  taken_at: number;
  inbounds: number;
  clients: number;
}

export interface InboundPlan {
  remark: string;
  protocol: string;
  port: number;
  /** add 面板上没有,会新建;exists 同端口同协议的已在 */
  action: 'add' | 'exists';
  note?: string;
}

export interface ClientPlan {
  email: string;
  /** add 新建;attach 已有,补挂到缺的入站;exists 不用动;skip 快照里就没挂在任何入站上 */
  action: 'add' | 'attach' | 'exists' | 'skip';
  /** 要新建到 / 补挂到的入站 */
  inbounds: string[];
}

export interface RestorePlan {
  inbounds: InboundPlan[];
  clients: ClientPlan[];
  xray: { same: boolean; current: XrayCounts; snapshot: XrayCounts };
  warnings: string[];
}

interface XrayCounts {
  outbounds: number;
  rules: number;
}

export interface RestoreStep {
  what: string;
  ok: boolean;
  error?: string;
}

const omit = (o: any, keys: string[]) => Object.fromEntries(Object.entries(o ?? {}).filter(([k]) => !keys.includes(k)));
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

function withoutClients(settings: unknown): unknown {
  const s = decodeJson(settings);
  return s && typeof s === 'object' && Array.isArray(s.clients) ? JSON.stringify({ ...s, clients: [] }) : settings;
}

/** 读面板当前配置;去掉流量、时间戳这些常变的字段,配置不变时内容就不变 */
export async function readPanelConfig(reader: SnapshotReader): Promise<SnapshotData> {
  const [inbounds, clients, raw] = await Promise.all([reader.listInbounds(), reader.exportClients(), reader.xraySettings()]);
  const xray = xrayConfig(raw);
  // 读坏了的 Xray 配置不能存成快照,否则按它恢复会把面板的路由、出站清空
  if (!Array.isArray(xray.outbounds) || !xray.outbounds.length) throw new Error('读到的 Xray 配置不完整(没有出站)');
  const testUrl = decodeJson(raw)?.outboundTestUrl;
  return {
    inbounds: inbounds.map((i) => {
      const rest = omit(i, ['up', 'down', 'clientStats', 'lastTrafficResetTime']);
      return { ...rest, settings: withoutClients(rest.settings) };
    }),
    clients: clients
      .map((e) => ({ client: omit(e.client, ['created_at', 'updated_at']), inboundIds: (e.inboundIds ?? []).map(Number) }))
      .sort((a, b) => String(a.client.email).localeCompare(String(b.client.email))),
    xray,
    testUrl: typeof testUrl === 'string' ? testUrl : '',
  };
}

/** 读面板配置,和这台面板最新一份快照不同才存;空面板(没有入站)不存。返回是否存了 */
export async function takeSnapshot(db: DB, panel: Panel, reader: SnapshotReader, now = Date.now()): Promise<boolean> {
  const data = await readPanelConfig(reader);
  if (!data.inbounds.length) return false;
  const json = JSON.stringify(data);
  const hash = createHash('sha256').update(json).digest('hex');
  const last = db.prepare('SELECT hash FROM panel_snapshots WHERE panel_id = ? ORDER BY taken_at DESC, id DESC LIMIT 1').get(panel.id) as
    | { hash: string }
    | undefined;
  if (last?.hash === hash) return false;
  db.prepare('INSERT INTO panel_snapshots (panel_id, taken_at, hash, inbounds, clients, data) VALUES (?, ?, ?, ?, ?, ?)').run(
    panel.id,
    now,
    hash,
    data.inbounds.length,
    data.clients.length,
    gzipSync(json),
  );
  return true;
}

export function listSnapshots(db: DB, panelId: number): SnapshotView[] {
  return db
    .prepare('SELECT id, taken_at, inbounds, clients FROM panel_snapshots WHERE panel_id = ? ORDER BY taken_at DESC, id DESC')
    .all(panelId) as SnapshotView[];
}

export function loadSnapshot(db: DB, panelId: number, id: number): SnapshotData {
  const row = db.prepare('SELECT data FROM panel_snapshots WHERE id = ? AND panel_id = ?').get(id, panelId) as { data: Buffer } | undefined;
  if (!row) throw new InputError('快照不存在');
  return JSON.parse(gunzipSync(row.data).toString('utf8'));
}

/** 删掉超过 keepDays 天的快照,但每台面板最近 KEEP_LATEST 份不论多旧都留着;返回删掉的份数 */
export function pruneSnapshots(db: DB, keepDays: number, now = Date.now()): number {
  return db
    .prepare(
      `DELETE FROM panel_snapshots WHERE id IN (
         SELECT id FROM (
           SELECT id, taken_at, ROW_NUMBER() OVER (PARTITION BY panel_id ORDER BY taken_at DESC, id DESC) AS n FROM panel_snapshots
         ) WHERE n > ? AND taken_at < ?
       )`,
    )
    .run(KEEP_LATEST, now - keepDays * DAY_MS).changes;
}

/** 每小时给各启用的面板存一次快照(有变化才存),再清理过期的 */
export function startPanelSnapshots(db: DB, clientFor: (panel: Panel) => SnapshotReader, keepDays: number): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await mapLimit(
        listPanels(db).filter((p) => p.enabled),
        4,
        async (panel) => {
          const reader = clientFor(panel);
          try {
            if (await takeSnapshot(db, panel, reader)) console.log('[配置快照]', panel.name, '已存一份');
          } catch (e) {
            console.error('[配置快照]', panel.name, '读取失败:', message(e));
          } finally {
            await reader.close?.();
          }
        },
      );
      const removed = pruneSnapshots(db, keepDays);
      if (removed) console.log('[配置快照] 删除过期快照', removed, '份');
    } catch (e) {
      console.error('[配置快照] 失败:', e);
    } finally {
      running = false;
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), HOUR_MS);
  return () => clearInterval(timer);
}

// ---------- 恢复 ----------

/** 入站以监听地址 + 端口 + 协议认定是不是同一个(同一端口可以同时有 TCP 和 UDP 的入站) */
const keyOf = (i: any) => `${i.listen || ''}:${i.port}/${i.protocol}`;
const labelOf = (i: any) => String(i.remark || `${i.protocol}:${i.port}`);

function xrayCounts(x: any): XrayCounts {
  return {
    outbounds: Array.isArray(x?.outbounds) ? x.outbounds.length : 0,
    rules: Array.isArray(x?.routing?.rules) ? x.routing.rules.length : 0,
  };
}

/** 路由规则里引用的入站 tag 换成面板上实际的 tag(重建的入站 tag 和原来不同时) */
function remapInboundTags(xray: any, tags: Map<string, string>): any {
  const x = structuredClone(xray);
  for (const rule of Array.isArray(x?.routing?.rules) ? x.routing.rules : []) {
    if (Array.isArray(rule?.inboundTag)) rule.inboundTag = rule.inboundTag.map((t: string) => tags.get(t) ?? t);
  }
  return x;
}

/** 快照里的入站 tag → 面板上同一入站的 tag */
function tagMap(snap: SnapshotData, live: any[]): Map<string, string> {
  const byKey = new Map(live.map((i) => [keyOf(i), i]));
  const tags = new Map<string, string>();
  for (const i of snap.inbounds) {
    const l = byKey.get(keyOf(i));
    if (l && i.tag && l.tag) tags.set(i.tag, l.tag);
  }
  return tags;
}

function certFiles(inbound: any): string[] {
  const certs = decodeJson(inbound.streamSettings)?.tlsSettings?.certificates;
  return (Array.isArray(certs) ? certs : []).flatMap((c: any) => [c?.certificateFile, c?.keyFile]).filter((f): f is string => !!f);
}

/** 对比快照和面板现状,算出恢复要做什么(不改面板) */
export function planRestore(snap: SnapshotData, cur: SnapshotData): RestorePlan {
  const curByKey = new Map(cur.inbounds.map((i) => [keyOf(i), i]));
  const inbounds: (InboundPlan & { key: string })[] = snap.inbounds.map((i) => {
    const base = { key: keyOf(i), remark: labelOf(i), protocol: String(i.protocol), port: Number(i.port) };
    const c = curByKey.get(base.key);
    if (!c) return { ...base, action: 'add' };
    return { ...base, action: 'exists', ...(labelOf(c) !== base.remark ? { note: `面板上叫「${labelOf(c)}」` } : {}) };
  });
  const byId = new Map(snap.inbounds.map((i, n) => [Number(i.id), inbounds[n]]));
  const curKeyById = new Map(cur.inbounds.map((i) => [Number(i.id), keyOf(i)]));
  const curClients = new Map(cur.clients.map((e) => [String(e.client.email), new Set(e.inboundIds.map((id) => curKeyById.get(id)))]));

  const clients: ClientPlan[] = snap.clients.map((e) => {
    const email = String(e.client.email);
    const targets = e.inboundIds.flatMap((id) => byId.get(id) ?? []);
    const have = curClients.get(email);
    if (!targets.length) return { email, action: have ? 'exists' : 'skip', inbounds: [] };
    if (!have) return { email, action: 'add', inbounds: targets.map((t) => t.remark) };
    const missing = targets.filter((t) => !have.has(t.key));
    return { email, action: missing.length ? 'attach' : 'exists', inbounds: missing.map((t) => t.remark) };
  });

  const warnings: string[] = [];
  const files = new Set(snap.inbounds.filter((_, n) => inbounds[n].action === 'add').flatMap(certFiles));
  if (files.size) {
    warnings.push(`要新建的入站用到面板机器上的证书文件(${[...files].join('、')}):先在面板里申请好证书、放到同样的路径,否则 Xray 起不来。`);
  }
  const target = remapInboundTags(snap.xray, tagMap(snap, cur.inbounds));
  return {
    inbounds: inbounds.map(({ key: _key, ...p }) => p),
    clients,
    xray: { same: JSON.stringify(target) === JSON.stringify(cur.xray), current: xrayCounts(cur.xray), snapshot: xrayCounts(snap.xray) },
    warnings,
  };
}

/** 正在恢复的面板:同一台不能同时跑两次(重复点、请求超时后重试),否则会重复新建 */
const restoring = new Set<number>();

/** 按快照恢复面板:先给现状存一份快照,再新建缺的入站、client,补挂入站,可选换回 Xray 模板并重启 */
export async function restorePanel(
  db: DB,
  panel: Panel,
  snapshotId: number,
  restorer: PanelRestorer,
  opts: { xray: boolean },
  now = Date.now(),
): Promise<RestoreStep[]> {
  if (restoring.has(panel.id)) throw new InputError('这台面板正在恢复,等它做完再看');
  restoring.add(panel.id);
  try {
    return await restore(db, panel, snapshotId, restorer, opts, now);
  } finally {
    restoring.delete(panel.id);
  }
}

async function restore(db: DB, panel: Panel, snapshotId: number, restorer: PanelRestorer, opts: { xray: boolean }, now: number): Promise<RestoreStep[]> {
  const snap = loadSnapshot(db, panel.id, snapshotId);
  // 换了 Xray 配置后出问题,还能按这份把 Xray 配置换回来(补建的入站、client 不会被删)
  await takeSnapshot(db, panel, restorer, now);
  const cur = await readPanelConfig(restorer);
  const plan = planRestore(snap, cur);
  const steps: RestoreStep[] = [];
  const step = async (what: string, fn: () => Promise<void>) => {
    try {
      await fn();
      steps.push({ what, ok: true });
      return true;
    } catch (e) {
      steps.push({ what, ok: false, error: message(e) });
      return false;
    }
  };

  for (const [n, p] of plan.inbounds.entries()) {
    if (p.action === 'add') await step(`新建入站「${p.remark}」`, () => restorer.addInbound(omit(snap.inbounds[n], ['id', 'originNodeGuid'])));
  }

  // 快照里的入站 id → 面板上现在的 id
  const live = await restorer.listInbounds();
  const liveByKey = new Map(live.map((i) => [keyOf(i), i]));
  const ids = new Map<number, number>();
  for (const i of snap.inbounds) {
    const l = liveByKey.get(keyOf(i));
    if (l) ids.set(Number(i.id), Number(l.id));
  }
  const curIds = new Map(cur.clients.map((e) => [String(e.client.email), new Set(e.inboundIds)]));

  for (const [n, p] of plan.clients.entries()) {
    if (p.action !== 'add' && p.action !== 'attach') continue;
    const e = snap.clients[n];
    const target = e.inboundIds.flatMap((id) => ids.get(id) ?? []);
    if (p.action === 'add') {
      if (target.length) await step(`新建 client ${p.email}`, () => restorer.addClient(e.client, target));
      else steps.push({ what: `新建 client ${p.email}`, ok: false, error: '它的入站没建起来' });
    } else {
      const missing = target.filter((id) => !curIds.get(p.email)?.has(id));
      if (missing.length) await step(`把 ${p.email} 挂到 ${p.inbounds.join('、')}`, () => restorer.attachClient(p.email, missing));
    }
  }

  const xray = remapInboundTags(snap.xray, tagMap(snap, live));
  if (opts.xray && JSON.stringify(xray) !== JSON.stringify(cur.xray)) {
    const saved = await step('换成快照里的 Xray 配置(路由、出站)', () => restorer.updateXray(xray, snap.testUrl || cur.testUrl || DEFAULT_TEST_URL));
    if (saved) await step('重启 Xray', () => restorer.restartXray());
  }
  return steps;
}
