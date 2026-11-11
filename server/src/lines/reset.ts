// 清零客户的流量:各线路的客户端在面板上 resetTraffic,本地记录归零。手动「清零流量」和按月清零都走这里。

import { customersDueReset, getCustomer, markReset, zeroLineTraffic, type CustomerView } from '../customers/repo';
import type { DB } from '../db';
import { getPanel, type Panel } from '../panels/repo';
import { errorText, panelKey, serial, using } from '../util';
import { forgetNotified } from '../notify/events';

export interface ResetAdmin {
  resetClientTraffic(email: string): Promise<void>;
  close?(): Promise<void>;
}

export interface ResetFailure {
  line: string;
  error: string;
}

/** 返回没清成的线路;清成的本地流量归零 */
export async function resetCustomerUsage(db: DB, c: CustomerView, adminFor: (panel: Panel) => ResetAdmin): Promise<ResetFailure[]> {
  const failed: ResetFailure[] = [];
  const byPanel = new Map<number, typeof c.lines>();
  for (const l of c.lines) byPanel.set(l.panel_id, [...(byPanel.get(l.panel_id) ?? []), l]);
  for (const [panelId, lines] of byPanel) {
    const panel = getPanel(db, panelId);
    if (!panel) continue;
    await serial(panelKey(panelId), () =>
      using(adminFor(panel), async (admin) => {
        for (const line of lines) {
          try {
            await admin.resetClientTraffic(line.email);
            zeroLineTraffic(db, line.id);
          } catch (e) {
            failed.push({ line: `${line.panel_name} 上的 ${line.email}`, error: errorText(e) });
          }
        }
      }),
    );
  }
  // 「流量用到 90%」下个周期要能再提醒
  forgetNotified(db, `quota:${c.id}:`);
  return failed;
}

export interface MonthlyResetResult {
  customer: CustomerView;
  failed: ResetFailure[];
}

/** 到了清零日的客户逐个清零;有客户端没清成也算这期清过了(本地记录已归零,面板上那个下次同步会把流量带回来,下期再清) */
export async function runMonthlyResets(db: DB, adminFor: (panel: Panel) => ResetAdmin, now = Date.now()): Promise<MonthlyResetResult[]> {
  const out: MonthlyResetResult[] = [];
  for (const c of customersDueReset(db, now)) {
    const failed = await resetCustomerUsage(db, c, adminFor);
    markReset(db, c.id, now);
    out.push({ customer: getCustomer(db, c.id) ?? c, failed });
  }
  return out;
}
