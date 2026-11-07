// 面板连通性检查:读一遍入站和 client,记下数量或错误。启动后定期跑,也可手动点。

import type { DB } from '../db';
import { normalizeClients } from '../xui/normalize';
import { getPanel, listPanels, recordCheck, type Panel } from './repo';

export interface PanelProbe {
  listInbounds(): Promise<any[]>;
  listClients(): Promise<any[]>;
  close?(): Promise<void>;
}

export async function checkPanel(db: DB, panel: Panel, probe: PanelProbe, now = Date.now()): Promise<Panel> {
  try {
    const [inbounds, clients] = await Promise.all([probe.listInbounds(), probe.listClients()]);
    recordCheck(db, panel.id, { ok: true, inbounds: inbounds.length, clients: normalizeClients(clients, inbounds).length }, now);
  } catch (e) {
    recordCheck(db, panel.id, { ok: false, error: e instanceof Error ? e.message : String(e) }, now);
  } finally {
    await probe.close?.().catch(() => {});
  }
  return getPanel(db, panel.id) ?? panel;
}

/** 检查全部面板,最多同时 4 台 */
export async function checkAllPanels(db: DB, probeFor: (panel: Panel) => PanelProbe): Promise<Panel[]> {
  const panels = listPanels(db);
  const out: Panel[] = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, panels.length) }, async () => {
      while (i < panels.length) out.push(await checkPanel(db, panels[i++], probeFor(panels[i - 1])));
    }),
  );
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
