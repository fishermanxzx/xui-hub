// 面板连通性检查:读一遍入站和 client,记下数量或错误。启动后定期跑,也可手动点。

import { linesOnPanel, updateLineStats } from '../customers/repo';
import type { DB } from '../db';
import { errorText, mapLimit, using } from '../util';
import { normalizeClients } from '../xui/normalize';
import { getPanel, listPanels, recordCheck, type Panel } from './repo';

export interface PanelProbe {
  listInbounds(): Promise<any[]>;
  listClients(): Promise<any[]>;
  /** 可选:面板版本与 Xray 状态,读不到不算检查失败 */
  serverStatus?(): Promise<{ panelVersion: string; xrayVersion: string; xrayState: string; xrayError: string }>;
  close?(): Promise<void>;
}

export function checkPanel(db: DB, panel: Panel, probe: PanelProbe, now = Date.now()): Promise<Panel> {
  return using(probe, async () => {
    try {
      const [inbounds, raw, status] = await Promise.all([probe.listInbounds(), probe.listClients(), probe.serverStatus?.().catch(() => null)]);
      const clients = normalizeClients(raw, inbounds);
      syncLines(db, panel.id, clients, now);
      recordCheck(
        db,
        panel.id,
        {
          ok: true,
          inbounds: inbounds.length,
          clients: clients.length,
          panel_version: status?.panelVersion || undefined,
          xray_version: status?.xrayVersion || undefined,
          xray_state: status ? status.xrayState || 'unknown' : undefined,
        },
        now,
      );
    } catch (e) {
      recordCheck(db, panel.id, { ok: false, error: errorText(e) }, now);
    }
    return getPanel(db, panel.id) ?? panel;
  });
}

/** 把面板上客户端的流量和启用状态写到对应线路;面板上已经没有的客户端算停用,流量保留 */
export function syncLines(db: DB, panelId: number, clients: ReturnType<typeof normalizeClients>, now = Date.now()): void {
  const byEmail = new Map(clients.map((c) => [c.email, c]));
  for (const line of linesOnPanel(db, panelId)) {
    const c = byEmail.get(line.email);
    if (c) updateLineStats(db, line.id, { up: c.up, down: c.down, enable: c.enable, last_online: c.lastOnline }, now);
    else updateLineStats(db, line.id, { up: line.up, down: line.down, enable: false, last_online: line.last_online }, now);
  }
}

/** 检查全部面板,最多同时 4 台 */
export async function checkAllPanels(db: DB, probeFor: (panel: Panel) => PanelProbe): Promise<Panel[]> {
  const out = await mapLimit(listPanels(db), 4, (panel) => checkPanel(db, panel, probeFor(panel)));
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
