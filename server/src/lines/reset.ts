// 清零客户的流量:各线路的客户端在面板上 resetTraffic,本地记录归零。手动「清零流量」和按月清零都走这里。

import { carryTraffic, clearCarried, customersDueReset, getCustomer, markReset, zeroLineTraffic, type CustomerView } from '../customers/repo';
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

/**
 * 返回没清成的线路;清成的本地流量归零。结转的(删掉的线路等)一起清零。
 * 面板上没清成的(连不上等):它的计数还是上期的,从结转里减掉,让客户本期从 0 算(不然新的一期一开始就带着上期用量,可能直接超额停用)。
 * 面板上的计数等下次清零再清;这期间要是在面板上被清零了,同步时旧计数会结转回来,正好抵掉
 */
export async function resetCustomerUsage(db: DB, c: CustomerView, adminFor: (panel: Panel) => ResetAdmin): Promise<ResetFailure[]> {
  const failed: ResetFailure[] = [];
  const missed: typeof c.lines = [];
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
            missed.push(line);
          }
        }
      }),
    );
  }
  clearCarried(db, c.id);
  for (const l of missed) carryTraffic(db, c.id, -l.up, -l.down);
  // 「流量用到 90%」下个周期要能再提醒
  forgetNotified(db, `quota:${c.id}:`);
  return failed;
}

export interface MonthlyResetResult {
  customer: CustomerView;
  /** 清零前的计费用量 */
  used: number;
  failed: ResetFailure[];
}

/** 到了清零日的客户逐个清零;有客户端在面板上没清成也算这期清过了(本期照样从 0 算,见 resetCustomerUsage,面板上的计数下期再清) */
export async function runMonthlyResets(db: DB, adminFor: (panel: Panel) => ResetAdmin, now = Date.now()): Promise<MonthlyResetResult[]> {
  const out: MonthlyResetResult[] = [];
  for (const c of customersDueReset(db, now)) {
    const failed = await resetCustomerUsage(db, c, adminFor);
    markReset(db, c.id, now);
    out.push({ customer: getCustomer(db, c.id) ?? c, used: c.used, failed });
  }
  return out;
}
