// 给客户开一条线路:在选定面板上挂到已有入站或新建入站,新建 client。只动这一块面板。
// - 不选出口:客户端从这块面板直出(kind = direct);
// - 选了出口(SOCKS 页登记的代理):给这个客户端(按 email)加一条到该代理的路由规则(kind = relay)。
//   规则按客户端区分,所以直出和走代理的客户端可以挂在同一个入站上,各走各的出口。
// 返回线路记录和客户端的分享链接。中途失败会把这次已经建的 client、路由规则、入站撤掉;同一块面板上的开 / 删线路排队执行。

import { addClientTo, ensureInbound, freeEmail, type ClientAdmin, type CreateOptions } from '../clients/create';
import { addLine, getCustomer, getLine, linesOnPanel, linesUsingSocks, setLineRoutes, setLineRules, type Line } from '../customers/repo';
import type { DB } from '../db';
import { getPanel, InputError, listPanels, type Panel } from '../panels/repo';
import { errorText, panelKey, serial, using } from '../util';
import { allSocks, getSocks, type SocksEndpoint } from '../socks/repo';
import { renameLinks, validNodeName } from '../subscription/nodeName';
import { XUIError } from '../xui/client';
import { editXray, parseExitSocksId, prepareExit, removeRoutes, routeUserToExit, setUserRules, socksServer, type ExitServer, type ResolvedRule, type RouteAdmin, type UserRoute } from './relay';
import { routesForClient } from './routes';
import { checkRulesGeo, type GeoValidator } from './geodata';
import { validRules, type LineRule } from './rules';

export interface LineAdmin extends ClientAdmin, RouteAdmin, GeoValidator {
  deleteClient(email: string): Promise<void>;
}

export interface OpenLineInput {
  kind?: unknown;
  panel_id?: unknown;
  /** 入站:给 id 用已有的;否则按 protocol(vless / hy2)复用或新建 */
  inbound?: { id?: unknown; protocol?: unknown } | null;
  /** 出口:{ kind: 'socks', socks_id }(SOCKS 页登记的代理);不给就从这块面板直出 */
  exit?: unknown;
  /** 自定义节点名(订阅里显示的名字),不给 = 用面板生成的 */
  node_name?: unknown;
  /** 出口规则(「条件 → 出口」),和出口路由在同一次 Xray 改动里写上;不给 = 不加 */
  rules?: unknown;
}

export interface OpenedLine {
  line: Line;
  links: string[];
  /** 这次在面板上新建了的入站 */
  created: { inbound: string | null };
}

export async function openLine(db: DB, customerId: number, input: OpenLineInput, adminFor: (panel: Panel) => LineAdmin, probe?: CreateOptions['probe']): Promise<OpenedLine> {
  const customer = getCustomer(db, customerId);
  if (!customer) throw new InputError('客户不存在');
  // kind 可省:给了出口就是 relay(走代理),没给就是 direct(直出)。显式写 relay 却没出口的照旧报错
  if (input.kind != null && input.kind !== 'direct' && input.kind !== 'relay') throw new InputError('线路类型只能是 direct(直出)或 relay(走 SOCKS 出口)');
  const wantsExit = input.kind === 'relay' || (input.kind == null && input.exit != null);
  const kind = wantsExit ? 'relay' : 'direct';
  const panel = getPanel(db, Number(input.panel_id));
  if (!panel) throw new InputError('面板不存在');
  const exit = wantsExit ? prepareExit(db, parseExitSocksId(input.exit)) : null;
  const nodeName = validNodeName(input.node_name);
  const rules = input.rules == null ? [] : validRules(db, input.rules);
  const resolved = resolveRules(db, rules);

  return serial(panelKey(panel.id), () =>
    using(adminFor(panel), async (admin) => {
      // 每做成一步就记下怎么撤;后面失败了倒着撤一遍(撤不掉的不管),再把原来的错误抛出去
      const undo: (() => Promise<unknown>)[] = [];
      try {
        // 规则里的 geo 写法先按这块面板的库核对,对不上就什么都不建
        if (rules.length) await checkRulesGeo(admin, rules);
        const opts: CreateOptions = { otherPanels: listPanels(db), adminFor, probe };
        const { inbound, created, protocol } = await ensureInbound(panel, admin, { inbound_id: input.inbound?.id, protocol: input.inbound?.protocol }, opts);
        if (created) undo.push(() => admin.deleteInbound(Number(inbound.id)));
        if ((exit || rules.length) && !inbound.tag) throw new InputError('这个入站没有 tag,没法按客户端加路由规则');
        // 本地记着、面板上却被人删掉的线路,email 也要避开
        const email = await freeEmail(admin, customer.name, linesOnPanel(db, panel.id).map((l) => l.email));
        // 出口路由和出口规则一次写上,Xray 只重启一次
        let edited: any = null;
        if (exit || rules.length) {
          const inboundTag = String(inbound.tag);
          undo.push(() => removeRoutes(admin, [{ inboundTag, email }]));
          await editXray(admin, (xray) => {
            if (!Array.isArray(xray.outbounds) || !xray.outbounds.length) throw new Error('读到的 Xray 配置不完整(没有出站)');
            if (exit) routeUserToExit(xray, inboundTag, email, exit.server);
            if (resolved.length) setUserRules(xray, inboundTag, email, resolved);
            edited = xray;
          });
        }
        undo.push(() => admin.deleteClient(email));
        const links = await addClientTo(admin, inbound, email);
        const line = addLine(db, {
          customer_id: customer.id,
          kind,
          panel_id: panel.id,
          inbound_id: Number(inbound.id),
          inbound_remark: String(inbound.remark ?? ''),
          protocol,
          email,
          exit_kind: exit ? 'socks' : null,
          exit_panel_id: null,
          exit_port: null,
          exit_socks_id: exit?.socks_id ?? null,
          exit_label: exit?.label ?? '',
          node_name: nodeName,
        });
        if (rules.length) setLineRules(db, line.id, rules);
        if (edited) setLineRoutes(db, line.id, routesForClient(edited, String(inbound.tag), email, allSocks(db).map((s) => ({ id: s.id, host: s.host, port: s.port }))));
        return { line: getLine(db, line.id) ?? line, links: renameLinks(links, nodeName), created: { inbound: created ? String(inbound.remark ?? '') : null } };
      } catch (e) {
        for (const step of undo.reverse()) await step().catch(() => {});
        throw e;
      }
    }),
  );
}

/** 把线路按面板分组,每块面板排队、只连一次地做 fn;面板已经不在的跳过。返回没做成的面板、它上面的线路和原因 */
async function onEachPanel(db: DB, lines: Line[], adminFor: (panel: Panel) => LineAdmin, fn: (admin: LineAdmin, group: Line[]) => Promise<void>) {
  const byPanel = new Map<number, Line[]>();
  for (const line of lines) byPanel.set(line.panel_id, [...(byPanel.get(line.panel_id) ?? []), line]);
  const failed: { panel: Panel; lines: Line[]; error: unknown }[] = [];
  await Promise.all(
    [...byPanel].map(async ([panelId, group]) => {
      const panel = getPanel(db, panelId);
      if (!panel) return;
      await serial(panelKey(panelId), () => using(adminFor(panel), (admin) => fn(admin, group))).catch((error) => failed.push({ panel, lines: group, error }));
    }),
  );
  return failed;
}

/** 中转线路和配了出口规则的线路在面板上的规则是哪几条(入站 tag + email);入站已经不在的略过 */
async function routesOf(admin: LineAdmin, lines: Line[]): Promise<UserRoute[]> {
  const relays = lines.filter((l) => l.kind === 'relay' || l.rules.length > 0);
  if (!relays.length) return [];
  const tags = new Map((await admin.listInbounds()).map((ib) => [Number(ib.id), ib.tag]));
  return relays.filter((l) => tags.get(l.inbound_id)).map((l) => ({ inboundTag: String(tags.get(l.inbound_id)), email: l.email }));
}

/**
 * 删掉这些线路在面板上的 client(面板上已经没有也算成功)和中转线路的出口规则(入站不动)。
 * 同一块面板上的一起做:只连一次,Xray 最多重启一次。返回没做成的线路和原因,调用方负责删记录
 */
export async function removeLines(db: DB, lines: Line[], adminFor: (panel: Panel) => LineAdmin): Promise<{ line: Line; error: unknown }[]> {
  const failed = await onEachPanel(db, lines, adminFor, async (admin, group) => {
    const present = new Set((await admin.listClients()).map((c) => String(c.email)));
    for (const line of group) if (present.has(line.email)) await admin.deleteClient(line.email);
    const routes = await routesOf(admin, group);
    if (routes.length) await removeRoutes(admin, routes);
  });
  return failed.flatMap((f) => f.lines.map((line) => ({ line, error: f.error })));
}

/** 删一条线路在面板上的东西,失败就抛出 */
export async function removeLine(db: DB, line: Line, adminFor: (panel: Panel) => LineAdmin): Promise<void> {
  const [failed] = await removeLines(db, [line], adminFor);
  if (failed) throw failed.error;
}

/**
 * SOCKS 换了地址 / 账号:把走它的中转线路在各自中转面板上的出口规则改指到新地址(旧出站没人用了随之删掉),每块面板重启一次 Xray。
 * 有面板没改成就抛错,调用方这时不保存新地址;处理好再保存一次即可,已经改好的面板不会再重启
 */
export async function repointSocksLines(db: DB, socksId: number, to: SocksEndpoint, adminFor: (panel: Panel) => LineAdmin): Promise<void> {
  const server = socksServer(to);
  const failed = await onEachPanel(db, linesUsingSocks(db, socksId), adminFor, async (admin, group) => {
    const tags = new Map((await admin.listInbounds()).map((ib) => [Number(ib.id), String(ib.tag ?? '')]));
    await editXray(admin, (xray) => {
      if (!Array.isArray(xray.outbounds) || !xray.outbounds.length) throw new Error('读到的 Xray 配置不完整(没有出站)');
      for (const l of group) {
        const tag = tags.get(l.inbound_id);
        if (!tag) continue;
        if (l.kind === 'relay' && l.exit_socks_id === socksId) routeUserToExit(xray, tag, l.email, server);
        if (l.rules.some((r) => r.to.kind === 'socks' && r.to.socks_id === socksId)) setUserRules(xray, tag, l.email, resolveRules(db, l.rules, { id: socksId, server }));
      }
    });
  });
  if (failed.length) throw new XUIError(`这些中转上的出口没改成:${failed.map((f) => `${f.panel.name}(${errorText(f.error)})`).join('、')}。SOCKS 的新地址没有保存,处理好后再保存一次`);
}

/** 规则里的 SOCKS 换成它的地址和账号;override:改地址时用新的 */
function resolveRules(db: DB, rules: LineRule[], override?: { id: number; server: ExitServer }): ResolvedRule[] {
  return rules.map((r) => {
    if (r.to.kind !== 'socks') return { ...r, to: r.to };
    const id = r.to.socks_id;
    if (override && override.id === id) return { ...r, to: { kind: 'socks', server: override.server } };
    const s = getSocks(db, id);
    if (!s) throw new InputError(`规则用的 SOCKS(#${id})已经不在了`);
    return { ...r, to: { kind: 'socks', server: socksServer(s) } };
  });
}

/**
 * 保存一条线路的出口规则:写到它所在面板的 Xray 路由(本系统写的那几条整组替换,面板上手配的不动),
 * 重启 Xray(这块面板上的客户端断流几秒),成功了再存记录,并马上按新配置算一遍实际出口。空数组 = 去掉
 */
export async function applyLineRules(db: DB, line: Line, rules: LineRule[], adminFor: (panel: Panel) => LineAdmin): Promise<Line> {
  const panel = getPanel(db, line.panel_id);
  if (!panel) throw new InputError('这条线路的面板已经不在了');
  const resolved = resolveRules(db, rules);
  await serial(panelKey(panel.id), () =>
    using(adminFor(panel), async (admin) => {
      const tag = (await admin.listInbounds()).find((ib) => Number(ib.id) === line.inbound_id)?.tag;
      if (!tag) throw new InputError('面板上找不到这条线路的入站');
      await checkRulesGeo(admin, rules);
      let edited: any = null;
      await editXray(admin, (xray) => {
        if (!Array.isArray(xray.outbounds) || !xray.outbounds.length) throw new Error('读到的 Xray 配置不完整(没有出站)');
        setUserRules(xray, String(tag), line.email, resolved);
        edited = xray;
      });
      setLineRules(db, line.id, rules);
      if (edited) setLineRoutes(db, line.id, routesForClient(edited, String(tag), line.email, allSocks(db).map((s) => ({ id: s.id, host: s.host, port: s.port }))));
    }),
  );
  return getLine(db, line.id)!;
}
