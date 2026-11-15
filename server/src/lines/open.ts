// 给客户开一条线路:
// - 直连:在选定面板上,挂到已有入站或新建入站,新建 client;
// - 中转:先把出口准备好(SOCKS,或落地面板上的 socks 入站),在中转面板上选定 / 新建入站,给这个客户端(按 email)加一条到出口的路由规则,再新建 client。
//   规则按客户端区分,所以中转和直连的客户端可以挂在同一个入站上,各走各的出口。
// 返回线路记录和客户端的分享链接(链接指向客户端直连的那块面板:直连是落地本身,中转是中转机)。
// 中途失败会把这次已经建的 client、路由规则、入站撤掉;同一块面板上的开 / 删线路排队执行。

import { addClientTo, ensureInbound, freeEmail, type ClientAdmin, type CreateOptions } from '../clients/create';
import { addLine, getCustomer, linesOnPanel, linesViaSocks, type Line } from '../customers/repo';
import type { DB } from '../db';
import { getPanel, InputError, listPanels, type Panel } from '../panels/repo';
import { errorText, panelKey, serial, serialAll, using } from '../util';
import type { SocksEndpoint } from '../socks/repo';
import { XUIError } from '../xui/client';
import { applyRoutes, parseExitSpec, prepareExit, removeRoutes, socksServer, type ExitAdmin, type PreparedExit, type RouteAdmin, type UserRoute } from './relay';

export interface LineAdmin extends ClientAdmin, ExitAdmin, RouteAdmin {
  deleteClient(email: string): Promise<void>;
}

export interface OpenLineInput {
  kind?: unknown;
  panel_id?: unknown;
  /** 入站:给 id 用已有的;否则按 protocol(vless / hy2)复用或新建 */
  inbound?: { id?: unknown; protocol?: unknown } | null;
  /** 中转的出口 */
  exit?: unknown;
}

export interface OpenedLine {
  line: Line;
  links: string[];
  /** 在中转 / 落地上新建了的入站 */
  created: { inbound: string | null; exit_inbound: string | null };
}

export async function openLine(db: DB, customerId: number, input: OpenLineInput, adminFor: (panel: Panel) => LineAdmin, probe?: CreateOptions['probe']): Promise<OpenedLine> {
  const customer = getCustomer(db, customerId);
  if (!customer) throw new InputError('客户不存在');
  const kind = input.kind === 'relay' ? 'relay' : input.kind === 'direct' ? 'direct' : null;
  if (!kind) throw new InputError('线路类型只能是 direct(直连)或 relay(中转)');
  const panel = getPanel(db, Number(input.panel_id));
  if (!panel) throw new InputError(kind === 'relay' ? '中转面板不存在' : '面板不存在');
  const exitSpec = kind === 'relay' ? parseExitSpec(input.exit) : null;

  const keys = [panelKey(panel.id), ...(exitSpec?.kind === 'panel' ? [panelKey(exitSpec.panel_id)] : [])];
  return serialAll(keys, () =>
    using(adminFor(panel), async (admin) => {
      // 每做成一步就记下怎么撤;后面失败了倒着撤一遍(撤不掉的不管),再把原来的错误抛出去
      const undo: (() => Promise<unknown>)[] = [];
      try {
        const opts: CreateOptions = { otherPanels: listPanels(db), adminFor, probe };
        const { inbound, created, protocol } = await ensureInbound(panel, admin, { inbound_id: input.inbound?.id, protocol: input.inbound?.protocol }, opts);
        if (created) undo.push(() => admin.deleteInbound(Number(inbound.id)));
        if (exitSpec && !inbound.tag) throw new InputError('这个入站没有 tag,没法按客户端加路由规则');
        // 本地记着、面板上却被人删掉的线路,email 也要避开
        const email = await freeEmail(admin, customer.name, linesOnPanel(db, panel.id).map((l) => l.email));
        let exit: PreparedExit | null = null;
        if (exitSpec) {
          exit = await prepareExit(db, exitSpec, adminFor, new URL(panel.base_url).hostname);
          const landing = exit.created_inbound_id == null ? undefined : getPanel(db, exit.exit_panel_id!);
          if (landing) undo.push(() => using(adminFor(landing), (a) => a.deleteInbound(exit!.created_inbound_id!)));
          const route = { inboundTag: String(inbound.tag), email, server: exit.server };
          undo.push(() => removeRoutes(admin, [route]));
          await applyRoutes(admin, [route]);
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
          exit_kind: exit?.exit_kind ?? null,
          exit_panel_id: exit?.exit_panel_id ?? null,
          exit_port: exit?.exit_port ?? null,
          exit_socks_id: exit?.exit_socks_id ?? null,
          exit_label: exit?.label ?? '',
        });
        return { line, links, created: { inbound: created ? String(inbound.remark ?? '') : null, exit_inbound: exit?.created_inbound ?? null } };
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

/** 中转线路在面板上的规则是哪几条(入站 tag + email);入站已经不在的略过 */
async function routesOf(admin: LineAdmin, lines: Line[]): Promise<UserRoute[]> {
  const relays = lines.filter((l) => l.kind === 'relay');
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
  const failed = await onEachPanel(db, linesViaSocks(db, socksId), adminFor, async (admin, group) => {
    const routes = await routesOf(admin, group);
    if (routes.length) await applyRoutes(admin, routes.map((r) => ({ ...r, server })));
  });
  if (failed.length) throw new XUIError(`这些中转上的出口没改成:${failed.map((f) => `${f.panel.name}(${errorText(f.error)})`).join('、')}。SOCKS 的新地址没有保存,处理好后再保存一次`);
}
