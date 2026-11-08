// 给客户开一条线路:
// - 直连:在选定面板上,挂到已有入站或新建入站,新建 client;
// - 中转:先把出口准备好(SOCKS,或落地面板上的 socks 入站),在中转面板上选定 / 新建入站,给这个客户端(按 email)加一条到出口的路由规则,再新建 client。
//   规则按客户端区分,所以中转和直连的客户端可以挂在同一个入站上,各走各的出口。
// 返回线路记录和客户端的分享链接(链接指向客户端直连的那块面板:直连是落地本身,中转是中转机)。

import { addClientTo, ensureInbound, freeEmail, type ClientAdmin, type CreateOptions } from '../clients/create';
import { addLine, getCustomer, type Line } from '../customers/repo';
import type { DB } from '../db';
import { getPanel, InputError, listPanels, type Panel } from '../panels/repo';
import { applyRoute, parseExitSpec, prepareExit, removeRoute, type ExitAdmin, type RouteAdmin } from './relay';

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

  const admin = adminFor(panel);
  try {
    const opts: CreateOptions = { otherPanels: listPanels(db), adminFor, probe };
    const { inbound, created, protocol } = await ensureInbound(panel, admin, { inbound_id: input.inbound?.id, protocol: input.inbound?.protocol }, opts);
    const email = await freeEmail(admin, customer.name);
    let exit = null;
    if (exitSpec) {
      exit = await prepareExit(db, exitSpec, adminFor, new URL(panel.base_url).hostname);
      if (!inbound.tag) throw new Error('入站没有 tag,没法加路由规则');
      await applyRoute(admin, String(inbound.tag), email, exit.server);
    }
    const { links } = await addClientTo(admin, inbound, customer.name, email);
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
  } finally {
    await admin.close?.().catch(() => {});
  }
}

/** 删掉线路对应的 client(面板上已经没有也算成功);中转线路再把他的出口规则去掉(入站和出站不动)。调用方负责删记录 */
export async function removeLine(db: DB, line: Line, adminFor: (panel: Panel) => LineAdmin): Promise<void> {
  const panel = getPanel(db, line.panel_id);
  if (!panel) return;
  const admin = adminFor(panel);
  try {
    const exists = (await admin.listClients()).some((c) => c.email === line.email);
    if (exists) await admin.deleteClient(line.email);
    if (line.kind === 'relay') {
      const tag = (await admin.listInbounds()).find((ib) => Number(ib.id) === line.inbound_id)?.tag;
      if (tag) await removeRoute(admin, String(tag), line.email);
    }
  } finally {
    await admin.close?.().catch(() => {});
  }
}
