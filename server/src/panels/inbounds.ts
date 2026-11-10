// 面板详情:现取一台面板的入站和挂在上面的 client。只读;不返回任何密钥(uuid、密码、reality 私钥、证书路径等)。

import { CLIENT_PROTOCOLS } from '../clients/create';
import { decodeJson } from '../xui/json';
import { normalizeClients } from '../xui/normalize';
import type { Panel } from './repo';

export interface PanelReader {
  listInbounds(): Promise<any[]>;
  listClients(): Promise<any[]>;
  close?(): Promise<void>;
}

export interface PanelClientView {
  email: string;
  enable: boolean;
  up: number;
  down: number;
  total_bytes: number;
  expiry_ms: number;
  last_online: number;
}

export interface InboundView {
  id: number;
  remark: string;
  protocol: string;
  port: number;
  enable: boolean;
  /** 这种协议的入站能不能挂客户端 */
  accepts_clients: boolean;
  /** 传输 / 安全,如 tcp / reality */
  transport: string;
  clients: PanelClientView[];
}

export interface PanelDetail {
  panel: { id: number; name: string };
  fetched_at: number;
  inbounds: InboundView[];
  /** 没挂在任何入站上的 client */
  unattached: PanelClientView[];
}

export function buildPanelDetail(panel: Panel, raw: { inbounds: any[]; clients: any[] }, now = Date.now()): PanelDetail {
  const clients = normalizeClients(raw.clients, raw.inbounds);
  const view = (c: (typeof clients)[number]): PanelClientView => ({
    email: c.email,
    enable: c.enable,
    up: c.up,
    down: c.down,
    total_bytes: c.totalBytes,
    expiry_ms: c.expiryMs,
    last_online: c.lastOnline,
  });
  const byEmail = (a: PanelClientView, b: PanelClientView) => a.email.localeCompare(b.email, 'zh-CN');
  const inbounds = raw.inbounds.map((ib): InboundView => {
    const id = Number(ib.id);
    const stream = decodeJson(ib.streamSettings) ?? {};
    return {
      id,
      remark: String(ib.remark ?? ''),
      protocol: String(ib.protocol ?? ''),
      port: Number(ib.port),
      enable: ib.enable !== false,
      accepts_clients: CLIENT_PROTOCOLS.has(String(ib.protocol)),
      transport: [stream.network, stream.security && stream.security !== 'none' ? stream.security : ''].filter(Boolean).join(' / '),
      clients: clients
        .filter((c) => c.inboundIds.includes(id))
        .map(view)
        .sort(byEmail),
    };
  });
  const ids = new Set(inbounds.map((i) => i.id));
  return {
    panel: { id: panel.id, name: panel.name },
    fetched_at: now,
    inbounds,
    unattached: clients
      .filter((c) => !c.inboundIds.some((i) => ids.has(i)))
      .map(view)
      .sort(byEmail),
  };
}

export async function readPanelDetail(panel: Panel, reader: PanelReader): Promise<PanelDetail> {
  try {
    const [inbounds, clients] = await Promise.all([reader.listInbounds(), reader.listClients()]);
    return buildPanelDetail(panel, { inbounds, clients });
  } finally {
    await reader.close?.().catch(() => {});
  }
}
