// 额度与到期的执行:每轮同步后,到期 / 超额客户还启用着的线路一律停用(面板上停用客户端);
// 客户回到正常(加额度、续期、清零)后,把本系统停掉的那些重新启用。面板上手动停的客户端不碰。

import { listCustomers, markLineAuto, type CustomerView, type Line } from '../customers/repo';
import type { DB } from '../db';
import { getPanel, type Panel } from '../panels/repo';

export interface EnforceAdmin {
  setClientsEnabled(emails: string[], enable: boolean): Promise<void>;
  close?(): Promise<void>;
}

export interface EnforceResult {
  customer: string;
  panel: string;
  email: string;
  action: 'disable' | 'enable';
  ok: boolean;
  error?: string;
}

/** 该客户的线路里要动的:不正常 → 停掉还启用着的;正常 → 恢复本系统停掉的 */
export function plannedOps(c: CustomerView): { line: Line; action: 'disable' | 'enable' }[] {
  if (c.state !== 'active') return c.lines.filter((l) => l.enable).map((line) => ({ line, action: 'disable' as const }));
  return c.lines.filter((l) => l.auto_disabled && !l.enable).map((line) => ({ line, action: 'enable' as const }));
}

export async function enforceCustomers(db: DB, adminFor: (panel: Panel) => EnforceAdmin, now = Date.now(), only?: number): Promise<EnforceResult[]> {
  const results: EnforceResult[] = [];
  // 按面板分组,一台面板一次请求
  const groups = new Map<number, { customer: CustomerView; line: Line; action: 'disable' | 'enable' }[]>();
  for (const c of listCustomers(db)) {
    if (only != null && c.id !== only) continue;
    for (const op of plannedOps({ ...c, state: c.state })) {
      const list = groups.get(op.line.panel_id) ?? [];
      list.push({ customer: c, ...op });
      groups.set(op.line.panel_id, list);
    }
  }
  for (const [panelId, ops] of groups) {
    const panel = getPanel(db, panelId);
    if (!panel) continue;
    const admin = adminFor(panel);
    try {
      for (const action of ['disable', 'enable'] as const) {
        const batch = ops.filter((o) => o.action === action);
        if (!batch.length) continue;
        try {
          await admin.setClientsEnabled(batch.map((o) => o.line.email), action === 'enable');
          for (const o of batch) {
            markLineAuto(db, o.line.id, action === 'disable', action === 'enable');
            results.push({ customer: o.customer.name, panel: panel.name, email: o.line.email, action, ok: true });
          }
        } catch (e) {
          const error = e instanceof Error ? e.message : String(e);
          for (const o of batch) results.push({ customer: o.customer.name, panel: panel.name, email: o.line.email, action, ok: false, error });
        }
      }
    } finally {
      await admin.close?.().catch(() => {});
    }
  }
  void now;
  return results;
}
