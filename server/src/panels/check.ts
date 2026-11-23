// 面板连通性检查:读一遍入站和 client,记下数量或错误。启动后定期跑,也可手动点。

import { carryTraffic, linesOnPanel, markLineAuto, setLineRoutes, updateLineStats } from '../customers/repo';
import { routesForClient } from '../lines/routes';
import { allSocks } from '../socks/repo';
import { xrayConfig } from '../xui/json';
import type { DB } from '../db';
import { recordTraffic } from '../traffic/daily';
import { errorText, mapLimit, serial, using } from '../util';
import { normalizeClients } from '../xui/normalize';
import { getPanel, listPanels, recordCheck, recordIp, type Panel } from './repo';

export interface PanelProbe {
  listInbounds(): Promise<any[]>;
  listClients(): Promise<any[]>;
  /** 可选:面板版本与 Xray 状态,读不到不算检查失败 */
  serverStatus?(): Promise<{ panelVersion: string; xrayVersion: string; xrayState: string; xrayError: string }>;
  /** 可选:Xray 配置(看线路实际从哪些出口出去),读不到不算检查失败 */
  xraySettings?(): Promise<unknown>;
  /** 可选:面板地址的 IP(域名就解析),拿不到返回 null,不影响检查 */
  hostIp?(): Promise<string | null>;
  close?(): Promise<void>;
}

/**
 * 同一块面板的检查排队跑(后台每轮的、立即同步、检查全部、单块检查、改面板后的):读面板和写流量要按先后来,
 * 不然先发起、后读完的那次会用更小的旧计数盖掉新的,被当成面板上清零过,客户用量翻倍、当天流量多记一整段。
 * now 不给就用真正开始读面板的时间(排在后面的要等前面的读完)
 */
export function checkPanel(db: DB, panel: Panel, probe: PanelProbe, at?: number): Promise<Panel> {
  return serial(`check:${panel.id}`, () => readPanel(db, panel, probe, at ?? Date.now()));
}

function readPanel(db: DB, panel: Panel, probe: PanelProbe, now: number): Promise<Panel> {
  return using(probe, async () => {
    // 和读面板同时解析;连不上时也记,通知里好知道是哪台
    const ip = probe.hostIp?.().catch(() => null);
    try {
      // 这块面板上有线路时才读 Xray 配置
      const hasLines = linesOnPanel(db, panel.id).length > 0;
      const [inbounds, raw, status, xray] = await Promise.all([
        probe.listInbounds(),
        probe.listClients(),
        probe.serverStatus?.().catch(() => null),
        hasLines && probe.xraySettings ? probe.xraySettings().catch(() => null) : null,
      ]);
      const clients = normalizeClients(raw, inbounds);
      syncLines(db, panel.id, clients, now);
      if (xray) syncRoutes(db, panel.id, inbounds, xrayConfig(xray), now);
      recordTraffic(db, panel.id, clients, now);
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
    const resolved = await ip;
    if (resolved) recordIp(db, panel.id, resolved);
    return getPanel(db, panel.id) ?? panel;
  });
}

/**
 * 把面板上客户端的流量和启用状态写到对应线路;面板上已经没有的客户端算停用,流量保留。
 * 面板上的计数比记下的小(在面板上清零过、删了重建同名客户端、面板重装):旧计数结转到客户身上,客户的已用不丢。
 * now 是开始读面板之前的时间:之后在 xui-hub 里清零过的线路,这次读到的是清零前的计数,不写回;
 * 比这次更晚开始的读面板已经写过的线路也不写(旧读数不能盖新的)。
 * 面板这次没给流量记录的客户端只更新启用状态,计数不动
 */
export function syncLines(db: DB, panelId: number, clients: ReturnType<typeof normalizeClients>, now = Date.now()): void {
  const byEmail = new Map(clients.map((c) => [c.email, c]));
  db.transaction(() => {
    for (const line of linesOnPanel(db, panelId)) {
      if (line.zeroed_at >= now || (line.synced_at != null && line.synced_at > now)) continue;
      const c = byEmail.get(line.email);
      if (!c) {
        updateLineStats(db, line.id, { up: line.up, down: line.down, enable: false, last_online: line.last_online }, now);
        // 面板上没这个客户端了:不再算「本系统停掉的」,不然客户恢复后每轮都去启用一个不存在的客户端
        if (line.auto_disabled) markLineAuto(db, line.id, false, false);
        continue;
      }
      if (c.hasTraffic === false) {
        updateLineStats(db, line.id, { up: line.up, down: line.down, enable: c.enable, last_online: line.last_online }, now);
        continue;
      }
      carryTraffic(db, line.customer_id, c.up < line.up ? line.up : 0, c.down < line.down ? line.down : 0, line.panel_ratio);
      updateLineStats(db, line.id, { up: c.up, down: c.down, enable: c.enable, last_online: c.lastOnline }, now);
    }
  })();
}

/** 按面板的 Xray 路由记下每条线路实际的出口;入站已经不在的线路不动 */
export function syncRoutes(db: DB, panelId: number, inbounds: any[], xray: any, now = Date.now()): void {
  const tagOf = new Map(inbounds.map((ib) => [Number(ib.id), String(ib.tag ?? '')]));
  const socks = allSocks(db).map((s) => ({ id: s.id, host: s.host, port: s.port }));
  for (const line of linesOnPanel(db, panelId)) {
    const tag = tagOf.get(line.inbound_id);
    if (tag) setLineRoutes(db, line.id, routesForClient(xray, tag, line.email, socks), now);
  }
}

/** 检查全部面板,最多同时 4 台 */
export async function checkAllPanels(db: DB, probeFor: (panel: Panel) => PanelProbe): Promise<Panel[]> {
  const out = await mapLimit(listPanels(db), 4, (panel) => checkPanel(db, panel, probeFor(panel)));
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
