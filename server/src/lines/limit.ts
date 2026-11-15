// 把面板客户端的 limitIp 写成某个值。0.9.0 用它做过「同时在线 IP 数」,现在设备数上限改在订阅链接上做(subscription/devices.ts),
// 这里只剩一个用途:升级后把当时写到面板上的 limitIp 清回 0。

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
