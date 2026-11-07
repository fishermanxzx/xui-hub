// 与 server 返回结构对应。

export interface Panel {
  id: number;
  name: string;
  base_url: string;
  created_at: number;
  /** 最近一次连通性检查 */
  checked_at: number | null;
  check_ok_at: number | null;
  check_error: string | null;
  inbound_count: number | null;
  client_count: number | null;
}

export interface PanelInput {
  name?: string;
  base_url?: string;
  token?: string;
}

export interface PanelClient {
  email: string;
  enable: boolean;
  up: number;
  down: number;
  total_bytes: number;
  expiry_ms: number;
  last_online: number;
}

export interface PanelInbound {
  id: number;
  remark: string;
  protocol: string;
  port: number;
  enable: boolean;
  transport: string;
  clients: PanelClient[];
}

export interface PanelDetail {
  panel: { id: number; name: string };
  fetched_at: number;
  inbounds: PanelInbound[];
  unattached: PanelClient[];
}

export type ClientProtocol = 'vless' | 'hy2';

export interface CreatedClient {
  email: string;
  protocol: 'vless' | 'hysteria';
  inbound: { id: number; remark: string; port: number; created: boolean };
  links: string[];
}
