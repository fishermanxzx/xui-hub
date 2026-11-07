// 给客户开一条线路:
// - 直连:在选定面板上,挂到已有入站或新建入站,新建 client;
// - 中转:先把出口准备好(SOCKS,或落地面板上的 socks 入站),在中转面板上选定 / 新建入站,把这个入站路由到出口,再新建 client。
// 返回线路记录和客户端的分享链接(链接指向客户端直连的那块面板:直连是落地本身,中转是中转机)。

import { addClientTo, ensureInbound, type ClientAdmin, type CreateOptions } from '../clients/create';
import { addLine, getCustomer, type Line } from '../customers/repo';
import type { DB } from '../db';
import { getPanel, InputError, listPanels, type Panel } from '../panels/repo';
import { applyRoute, parseExitSpec, prepareExit, type ExitAdmin, type RouteAdmin } from './relay';

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
    // 中转选「新建入站」时一定新建:复用已有入站会把它上面别的客户端一起路由到这个出口
    const { inbound, created, protocol } = await ensureInbound(panel, admin, { inbound_id: input.inbound?.id, protocol: input.inbound?.protocol, forceNew: kind === 'relay' }, opts);
    let exit = null;
    if (exitSpec) {
      exit = await prepareExit(db, exitSpec, adminFor, new URL(panel.base_url).hostname);
      if (!inbound.tag) throw new Error('入站没有 tag,没法加路由规则');
      await applyRoute(admin, String(inbound.tag), exit.server);
    }
    const { email, links } = await addClientTo(admin, inbound, customer.name);
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

/** 删掉线路对应的 client(面板上已经没有也算成功),再删记录 */
export async function removeLine(db: DB, line: Line, adminFor: (panel: Panel) => LineAdmin): Promise<void> {
  const panel = getPanel(db, line.panel_id);
  if (panel) {
    const admin = adminFor(panel);
    try {
      const exists = (await admin.listClients()).some((c) => c.email === line.email);
      if (exists) await admin.deleteClient(line.email);
    } finally {
      await admin.close?.().catch(() => {});
    }
  }
}
