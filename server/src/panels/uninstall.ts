// 卸载面板:删掉这台面板上客户线路的 client;卸载的是落地机时,其他面板上出口全部经过它的客户线路也一起删
// (那些面板上的入站、路由不动)。然后解绑这些线路,把面板从系统移除(它的配置快照随之删除)。
// 面板连不上时 client 删不掉,线路照样解绑,结果里列出来。经过它的出口只占一部分的线路不删,只列出来提醒。

import { deleteClients, type ClientRemover, type LineDeleteResult } from '../customers/panelOps';
import { removeBinding } from '../customers/repo';
import type { DB } from '../db';
import { exitKey, lineExits } from './exits';
import { deletePanel, getPanel, InputError, type Panel } from './repo';

export interface UninstallLine {
  binding_id: number;
  customer_id: number;
  customer_name: string;
  panel_id: number;
  panel_name: string;
  email: string;
}

export interface UninstallPlan {
  panel: { id: number; name: string; role: string };
  /** 直接挂在这台面板上的客户线路 */
  direct: UninstallLine[];
  /** 其他面板上、出口全部经过这台的客户线路 */
  through: UninstallLine[];
  /** 其他面板上、只有部分出口经过这台的客户线路(不删) */
  partial: UninstallLine[];
}

export async function planUninstall(db: DB, panelId: number): Promise<UninstallPlan> {
  const panel = getPanel(db, panelId);
  if (!panel) throw new InputError('面板不存在');
  const rows = db
    .prepare(
      `SELECT b.id AS binding_id, b.customer_id, c.name AS customer_name, b.panel_id, p.name AS panel_name, b.email
       FROM bindings b JOIN customers c ON c.id = b.customer_id JOIN panels p ON p.id = b.panel_id
       ORDER BY c.name COLLATE NOCASE, p.name, b.email`,
    )
    .all() as UninstallLine[];
  const exits = await lineExits(db);
  const plan: UninstallPlan = { panel: { id: panel.id, name: panel.name, role: panel.role }, direct: [], through: [], partial: [] };
  for (const line of rows) {
    if (line.panel_id === panelId) {
      plan.direct.push(line);
      continue;
    }
    const list = exits.get(exitKey(line.panel_id, line.email)) ?? [];
    const hit = list.filter((e) => e.through.includes(panelId)).length;
    if (hit) (hit === list.length ? plan.through : plan.partial).push(line);
  }
  return plan;
}

export async function uninstallPanel(
  db: DB,
  panelId: number,
  clientFor: (panel: Panel) => ClientRemover,
): Promise<{ plan: UninstallPlan; results: LineDeleteResult[] }> {
  const plan = await planUninstall(db, panelId);
  const lines = [...plan.direct, ...plan.through];
  const results = await deleteClients(db, lines, clientFor);
  db.transaction(() => {
    for (const line of lines) removeBinding(db, line.customer_id, line.binding_id);
    deletePanel(db, panelId);
  })();
  return { plan, results };
}
