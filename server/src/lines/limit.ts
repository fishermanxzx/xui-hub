// 同时在线 IP 数上限:客户上设一个数,写到他每条线路在面板上的客户端(limitIp)。
// 真正拦人的是面板:3x-ui 靠 fail2ban 按访问日志封超出的 IP,面板那台机器上要装了 fail2ban 才生效(Docker 版自带)。

import type { Line } from '../customers/repo';
import type { DB } from '../db';
import { getPanel, type Panel } from '../panels/repo';
import { errorText, panelKey, serial, using } from '../util';

export interface LimitAdmin {
  updateClient(email: string, patch: Record<string, unknown>): Promise<void>;
  close?(): Promise<void>;
}

export interface LimitFailure {
  line: string;
  error: string;
}

/** 把上限写到这些线路的客户端上,返回没写成的。面板已经不在的线路跳过 */
export async function applyLimitIp(db: DB, lines: Line[], limitIp: number, adminFor: (panel: Panel) => LimitAdmin): Promise<LimitFailure[]> {
  const failed: LimitFailure[] = [];
  const byPanel = new Map<number, Line[]>();
  for (const l of lines) byPanel.set(l.panel_id, [...(byPanel.get(l.panel_id) ?? []), l]);
  await Promise.all(
    [...byPanel].map(async ([panelId, group]) => {
      const panel = getPanel(db, panelId);
      if (!panel) return;
      await serial(panelKey(panelId), () =>
        using(adminFor(panel), async (admin) => {
          for (const line of group) {
            try {
              await admin.updateClient(line.email, { limitIp });
            } catch (e) {
              failed.push({ line: `${line.panel_name} 上的 ${line.email}`, error: errorText(e) });
            }
          }
        }),
      );
    }),
  );
  return failed;
}
