// 卸载 SOCKS:各面板上指向它的出站和路由规则都删掉;主去向是它的入站整个删掉,只挂在这些入站上的 client 先删、
// 对应的客户线路解绑。只有部分流量(按域名、按用户等)走它的规则只删规则,入站不动。
// 它是默认出站、有不限入站的规则把全部流量指向它、被负载均衡或其他出站引用的面板不自动处理,列出来去面板上改。
// 每台面板改之前先存一份配置快照(可按快照恢复),改完重启 Xray。全部面板都成功才把它从系统移除;
// 有失败的保留登记,处理好后再卸载一次即可(已改好的面板上找不到它,会跳过)。

import { removeBinding } from '../customers/repo';
import type { DB } from '../db';
import { exitKey, lineExits } from '../panels/exits';
import { plainInboundRule, resolveRoute } from '../panels/inbounds';
import { InputError, listPanels, type Panel } from '../panels/repo';
import { DEFAULT_TEST_URL, readPanelConfig, takeSnapshot, type RestoreStep, type SnapshotData, type SnapshotReader } from '../panels/snapshots';
import { mapLimit } from '../sync/service';
import { decodeJson as decode } from '../xui/json';
import { deleteSocks, getSocks, type SocksProxy } from './repo';

export interface SocksPanelEditor extends SnapshotReader {
  deleteClient(email: string): Promise<void>;
  deleteInbound(id: number): Promise<void>;
  updateXray(xray: unknown, testUrl: string): Promise<void>;
  restartXray(): Promise<void>;
}

export interface SocksPanelPlan {
  panel_id: number;
  panel: string;
  /** 指向这个 SOCKS 的出站 tag */
  outbounds: string[];
  /** 要删的路由规则条数(含只分流部分流量的) */
  rules: number;
  /** 主去向是它、整个删掉的入站 */
  inbounds: { id: number; remark: string; protocol: string; port: number }[];
  /** 只挂在这些入站上、一起删掉的 client;customer = 绑定的客户 */
  clients: { email: string; customer: { id: number; name: string } | null }[];
  /** 不能自动处理的原因;有它时这台面板不动 */
  blocked?: string;
}

export interface SocksIndirectLine {
  customer_id: number;
  customer_name: string;
  panel: string;
  email: string;
}

export interface SocksUninstallPlan {
  socks: { id: number; name: string; host: string; port: number };
  panels: SocksPanelPlan[];
  /** 读不到配置的面板(卸载时也跳过,SOCKS 保留登记) */
  errors: { panel: string; error: string }[];
  /** 出口经过它、但这次不删的客户线路(client 还挂在别的入站上,或经其他面板转过去) */
  indirect: SocksIndirectLine[];
}

export interface SocksPanelResult {
  panel: string;
  ok: boolean;
  steps: RestoreStep[];
}

export interface SocksUninstallResult {
  panels: SocksPanelResult[];
  errors: { panel: string; error: string }[];
  /** 全部面板都处理好了,已从系统移除 */
  removed: boolean;
}

interface PanelEdit {
  tags: string[];
  rules: number;
  inbounds: any[];
  clients: string[];
  blocked?: string;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const byPanel = (a: { panel: string }, b: { panel: string }) => a.panel.localeCompare(b.panel, 'zh-CN');

/** 一台面板上要改什么;没有指向它的出站返回 null */
export function planPanelEdit(cfg: SnapshotData, target: { host: string; port: number }): PanelEdit | null {
  const xray = cfg.xray ?? {};
  const outbounds: any[] = Array.isArray(xray.outbounds) ? xray.outbounds : [];
  const host = target.host.toLowerCase();
  const tags = outbounds
    .filter((o) => {
      const s = decode(o?.settings)?.servers?.[0];
      return o?.protocol === 'socks' && o.tag && String(s?.address ?? '').toLowerCase() === host && Number(s?.port) === target.port;
    })
    .map((o) => String(o.tag));
  if (!tags.length) return null;
  const mine = new Set(tags);
  const rules: any[] = Array.isArray(xray.routing?.rules) ? xray.routing.rules : [];
  const ctx = { panelHosts: new Map<string, string>(), socks: [] };
  const inbounds = cfg.inbounds.filter((i) => i.tag && mine.has(resolveRoute(xray, String(i.tag), [], ctx).route.outbound ?? ''));
  const ids = new Set(inbounds.map((i) => Number(i.id)));
  return {
    tags,
    rules: rules.filter((r) => mine.has(r?.outboundTag)).length,
    inbounds,
    clients: cfg.clients.filter((e) => e.inboundIds.length && e.inboundIds.every((id) => ids.has(id))).map((e) => String(e.client.email)),
    blocked: blockReason(xray, outbounds, rules, mine),
  };
}

function blockReason(xray: any, outbounds: any[], rules: any[], mine: Set<string>): string | undefined {
  if (mine.has(outbounds[0]?.tag)) return `出站 ${outbounds[0].tag} 是这台面板的默认出站(排第一)`;
  if (rules.some((r) => r?.enabled !== false && mine.has(r.outboundTag) && !r.inboundTag?.length && plainInboundRule(r))) {
    return '有不限入站的规则把全部流量指向它';
  }
  const tags = [...mine];
  const balancer = (Array.isArray(xray.routing?.balancers) ? xray.routing.balancers : []).find((b: any) =>
    (Array.isArray(b?.selector) ? b.selector : []).some((sel: string) => tags.some((t) => t.startsWith(sel))),
  );
  if (balancer) return `负载均衡 ${balancer.tag} 会选到它`;
  const chained = outbounds.find((o) => !mine.has(o?.tag) && (mine.has(o?.proxySettings?.tag) || mine.has(o?.streamSettings?.sockopt?.dialerProxy)));
  if (chained) return `出站 ${chained.tag} 经它转发`;
  return undefined;
}

/** 删掉这些出站和指向它们的规则;其他规则里去掉已删入站的 tag,去完不剩入站的规则也删(否则会变成对所有入站生效) */
export function editXray(xray: any, tags: Set<string>, deletedInbounds: Set<string>): any {
  const rules = (Array.isArray(xray.routing?.rules) ? xray.routing.rules : []).flatMap((r: any) => {
    if (tags.has(r?.outboundTag)) return [];
    if (!Array.isArray(r?.inboundTag) || !r.inboundTag.some((t: string) => deletedInbounds.has(t))) return [r];
    const left = r.inboundTag.filter((t: string) => !deletedInbounds.has(t));
    return left.length ? [{ ...r, inboundTag: left }] : [];
  });
  return { ...xray, outbounds: xray.outbounds.filter((o: any) => !tags.has(o?.tag)), routing: { ...xray.routing, rules } };
}

function customerOf(db: DB, panelId: number, email: string) {
  return (
    (db
      .prepare('SELECT c.id, c.name FROM bindings b JOIN customers c ON c.id = b.customer_id WHERE b.panel_id = ? AND b.email = ?')
      .get(panelId, email) as { id: number; name: string } | undefined) ?? null
  );
}

function socksOf(db: DB, id: number): SocksProxy {
  const s = getSocks(db, id);
  if (!s) throw new InputError('SOCKS 不存在');
  return s;
}

/** 各面板现读配置,列出卸载会改什么(不改面板) */
export async function planSocksUninstall(db: DB, socksId: number, editorFor: (panel: Panel) => SocksPanelEditor): Promise<SocksUninstallPlan> {
  const s = socksOf(db, socksId);
  const panels: SocksPanelPlan[] = [];
  const errors: { panel: string; error: string }[] = [];
  await mapLimit(
    listPanels(db).filter((p) => p.enabled),
    4,
    async (panel) => {
      const editor = editorFor(panel);
      try {
        const edit = planPanelEdit(await readPanelConfig(editor), s);
        if (!edit) return;
        panels.push({
          panel_id: panel.id,
          panel: panel.name,
          outbounds: edit.tags,
          rules: edit.rules,
          inbounds: edit.inbounds.map((i) => ({ id: Number(i.id), remark: String(i.remark ?? ''), protocol: String(i.protocol ?? ''), port: Number(i.port) })),
          clients: edit.clients.map((email) => ({ email, customer: customerOf(db, panel.id, email) })),
          ...(edit.blocked ? { blocked: edit.blocked } : {}),
        });
      } catch (e) {
        errors.push({ panel: panel.name, error: message(e) });
      } finally {
        await editor.close?.();
      }
    },
  );

  const covered = new Set(panels.filter((p) => !p.blocked).flatMap((p) => p.clients.map((c) => exitKey(p.panel_id, c.email))));
  const exits = await lineExits(db);
  const indirect = (
    db
      .prepare(
        `SELECT b.customer_id, c.name AS customer_name, b.panel_id, p.name AS panel, b.email
         FROM bindings b JOIN customers c ON c.id = b.customer_id JOIN panels p ON p.id = b.panel_id
         ORDER BY c.name COLLATE NOCASE, p.name, b.email`,
      )
      .all() as (SocksIndirectLine & { panel_id: number })[]
  )
    .filter((l) => !covered.has(exitKey(l.panel_id, l.email)) && (exits.get(exitKey(l.panel_id, l.email)) ?? []).some((e) => e.via === `SOCKS ${s.name}`))
    .map(({ panel_id: _, ...l }) => l);

  return { socks: { id: s.id, name: s.name, host: s.host, port: s.port }, panels: panels.sort(byPanel), errors: errors.sort(byPanel), indirect };
}

const uninstalling = new Set<number>();
// 卸载要重启各面板的 Xray,管理员自己的代理若也走这些面板,请求会断:浏览器可能重发,页面也会改成查进度。
// 所以最近的结果留一段时间,重发的请求和查进度都直接拿它
const RECENT_MS = 30 * 60_000;
const recent = new Map<number, { at: number; result: SocksUninstallResult }>();

export function uninstallStatus(socksId: number, now = Date.now()): { running: boolean; result: SocksUninstallResult | null } {
  const r = recent.get(socksId);
  return { running: uninstalling.has(socksId), result: r && now - r.at < RECENT_MS ? r.result : null };
}

export async function uninstallSocks(
  db: DB,
  socksId: number,
  editorFor: (panel: Panel) => SocksPanelEditor,
  now = Date.now(),
): Promise<SocksUninstallResult> {
  if (!getSocks(db, socksId)) {
    const done = uninstallStatus(socksId, now).result;
    if (done) return done;
  }
  const s = socksOf(db, socksId);
  if (uninstalling.has(s.id)) throw new InputError('正在卸载这个 SOCKS,等它做完再看');
  uninstalling.add(s.id);
  try {
    const panels: SocksPanelResult[] = [];
    const errors: { panel: string; error: string }[] = [];
    await mapLimit(
      listPanels(db).filter((p) => p.enabled),
      4,
      async (panel) => {
        const editor = editorFor(panel);
        try {
          const r = await uninstallOnPanel(db, panel, s, editor, now);
          if (r) panels.push(r);
        } catch (e) {
          errors.push({ panel: panel.name, error: message(e) });
        } finally {
          await editor.close?.();
        }
      },
    );
    const removed = !errors.length && panels.every((p) => p.ok);
    if (removed) deleteSocks(db, s.id);
    const result = { panels: panels.sort(byPanel), errors: errors.sort(byPanel), removed };
    recent.set(s.id, { at: Date.now(), result });
    return result;
  } finally {
    uninstalling.delete(s.id);
  }
}

async function uninstallOnPanel(db: DB, panel: Panel, s: SocksProxy, editor: SocksPanelEditor, now: number): Promise<SocksPanelResult | null> {
  const cfg = await readPanelConfig(editor);
  const edit = planPanelEdit(cfg, s);
  if (!edit) return null;
  const steps: RestoreStep[] = [];
  const result: SocksPanelResult = { panel: panel.name, ok: false, steps };
  if (edit.blocked) {
    steps.push({ what: '没有处理', ok: false, error: `${edit.blocked},先在面板上调整` });
    return result;
  }
  const step = async (what: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
      steps.push({ what, ok: true });
      return true;
    } catch (e) {
      steps.push({ what, ok: false, error: message(e) });
      return false;
    }
  };

  // 改之前存一份,出问题可以按快照恢复
  if (!(await step('存一份配置快照', () => takeSnapshot(db, panel, editor, now)))) return result;

  if (edit.clients.length) {
    const errs = new Map<string, string>();
    for (const email of edit.clients) await editor.deleteClient(email).catch((e) => errs.set(email, message(e)));
    const left = new Set((await editor.exportClients()).map((e) => String(e?.client?.email)));
    const gone = edit.clients.filter((email) => !left.has(email));
    db.transaction(() => {
      for (const email of gone) {
        for (const b of db.prepare('SELECT id, customer_id FROM bindings WHERE panel_id = ? AND email = ?').all(panel.id, email) as {
          id: number;
          customer_id: number;
        }[]) {
          removeBinding(db, b.customer_id, b.id);
        }
      }
    })();
    for (const email of edit.clients) {
      steps.push(left.has(email) ? { what: `删除 client ${email}`, ok: false, error: errs.get(email) ?? '删除后面板上还在' } : { what: `删除 client ${email}`, ok: true });
    }
    // client 没删干净就不动入站和路由,免得留下没有入站的 client
    if (steps.some((x) => !x.ok)) return result;
  }

  for (const i of edit.inbounds) await step(`删除入站「${i.remark || i.tag}」(${i.protocol}:${i.port})`, () => editor.deleteInbound(Number(i.id)));
  const ids = new Set(edit.inbounds.map((i) => Number(i.id)));
  const stillThere = (await editor.listInbounds()).filter((i) => ids.has(Number(i.id)));
  if (stillThere.length) steps.push({ what: '核对入站', ok: false, error: `删除后面板上还在:${stillThere.map((i) => i.remark || i.tag).join('、')}` });
  if (steps.some((x) => !x.ok)) return result;

  // 删入站后面板可能动过路由,重新读一遍再改
  const fresh = await readPanelConfig(editor);
  const next = editXray(fresh.xray, new Set(edit.tags), new Set(edit.inbounds.map((i) => String(i.tag))));
  const removedRules = (fresh.xray.routing?.rules?.length ?? 0) - next.routing.rules.length;
  const saved = await step(`删除出站 ${edit.tags.join('、')} 和 ${removedRules} 条路由规则`, () =>
    editor.updateXray(next, fresh.testUrl || cfg.testUrl || DEFAULT_TEST_URL),
  );
  if (!saved || !(await step('重启 Xray', () => editor.restartXray()))) return result;
  result.ok = true;
  await takeSnapshot(db, panel, editor).catch(() => {});
  return result;
}
