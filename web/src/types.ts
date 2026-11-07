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
  /** 最近一次检查读到的面板版本、Xray 内核版本和状态 */
  panel_version: string | null;
  xray_version: string | null;
  xray_state: string | null;
}

/** 现从面板取的版本信息 */
export interface PanelVersions {
  panel: { current: string; latest: string | null; update_available: boolean; channel: string | null };
  xray: { current: string; state: string; error: string; available: string[] };
}

export interface UpdateStatus {
  runId: string;
  state: 'pending' | 'success' | 'failed' | string;
  exitCode: number;
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

export interface SocksCheck {
  at: number;
  ok: boolean;
  ms: number;
  ip: string | null;
  loc: string | null;
  error: string | null;
}

export interface Socks {
  id: number;
  name: string;
  host: string;
  port: number;
  username: string;
  has_password: boolean;
  remark: string;
  created_at: number;
  updated_at: number;
  check: SocksCheck | null;
}

export interface SocksInput {
  name?: string;
  /** 新建必填;修改时留空 = 不改 */
  address?: string;
  remark?: string;
}

export type ClientProtocol = 'vless' | 'hy2';

export interface CreatedClient {
  email: string;
  protocol: 'vless' | 'hysteria';
  inbound: { id: number; remark: string; port: number; created: boolean };
  links: string[];
}
