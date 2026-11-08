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

export type LineKind = 'direct' | 'relay';
export type CustomerState = 'active' | 'expired' | 'over_quota';

export interface Line {
  id: number;
  customer_id: number;
  kind: LineKind;
  panel_id: number;
  panel_name: string;
  inbound_id: number;
  inbound_remark: string;
  protocol: string;
  email: string;
  exit_kind: 'panel' | 'socks' | null;
  exit_panel_id: number | null;
  exit_panel_name: string | null;
  exit_port: number | null;
  exit_socks_id: number | null;
  exit_socks_name: string | null;
  exit_label: string;
  created_at: number;
  /** 最近一次同步到的客户端流量与状态 */
  up: number;
  down: number;
  enable: boolean;
  auto_disabled: boolean;
  last_online: number;
  synced_at: number | null;
}

export interface Customer {
  id: number;
  name: string;
  remark: string;
  /** 总额度(字节),0 = 不限 */
  quota_bytes: number;
  /** 到期时间(毫秒),0 = 不限期 */
  expire_at: number;
  /** 订阅链接 /sub/<token> 里的 token */
  sub_token: string;
  /** 订阅链接;未配置 SUB_BASE_URL 时为 null,前端用当前地址拼 */
  sub_url: string | null;
  sub_fetched_at: number | null;
  sub_fetched_ua: string | null;
  /** 近几天拉订阅用过几个客户端(按 UA 区分)、来自几个 IP */
  sub_clients: number;
  sub_ips: number;
  created_at: number;
  updated_at: number;
  lines: Line[];
  used_up: number;
  used_down: number;
  used: number;
  state: CustomerState;
}

export interface SubFetch {
  at: number;
  customer_id: number;
  target: string;
  status: number;
  ua: string;
  ip: string;
}

export interface CustomerInput {
  name?: string;
  remark?: string;
  quota_bytes?: number;
  expire_at?: number;
}

export interface EnforceOp {
  customer: string;
  panel: string;
  email: string;
  action: 'disable' | 'enable';
  ok: boolean;
  error?: string;
}

/** 开线路的请求:直连选面板 + 入站;中转再选出口 */
export interface OpenLineInput {
  kind: LineKind;
  panel_id: number;
  inbound: { id?: number; protocol?: ClientProtocol };
  exit?: { kind: 'panel'; panel_id: number; inbound_id?: number | null } | { kind: 'socks'; socks_id: number };
}

export interface OpenedLine {
  line: Line;
  links: string[];
  created: { inbound: string | null; exit_inbound: string | null };
}

export interface CreatedClient {
  email: string;
  protocol: 'vless' | 'hysteria';
  inbound: { id: number; remark: string; port: number; created: boolean };
  links: string[];
}
