// 与 server 返回结构对应。

export type PanelRole = 'relay' | 'exit';
export type CustomerStatus = 'active' | 'disabled';
export type CustomerState = 'active' | 'disabled' | 'expired' | 'over_quota';

export interface Panel {
  id: number;
  name: string;
  base_url: string;
  ip: string | null;
  provider: string | null;
  role: PanelRole;
  monthly_cost: number | null;
  /** 机器到期时间:null = 未填,0 = 不限期 */
  expire_at: number | null;
  enabled: boolean;
  created_at: number;
  last_sync_at: number | null;
  last_sync_ok_at: number | null;
  last_sync_error: string | null;
  client_count: number | null;
}

/** 面板详情:现取的入站、去向和 client */
export type RouteKind = 'direct' | 'panel' | 'socks' | 'other' | 'block';

export interface PanelClient {
  email: string;
  enable: boolean;
  up: number;
  down: number;
  total_bytes: number;
  expiry_ms: number;
  last_online: number;
  customer: { id: number; name: string } | null;
}

export interface PanelInbound {
  id: number;
  remark: string;
  protocol: string;
  port: number;
  enable: boolean;
  transport: string;
  route: { kind: RouteKind; label: string; outbound: string | null };
  extra_rules: number;
  clients: PanelClient[];
}

export interface PanelDetail {
  panel: { id: number; name: string; role: PanelRole; ip: string | null };
  fetched_at: number;
  inbounds: PanelInbound[];
  unattached: PanelClient[];
}

/** 每日流量图的一组数据 */
export interface ChartSeries {
  key: string;
  label: string;
  values: number[];
  /** CSS 颜色,如 var(--series-1) */
  color: string;
  /** 合并出来的「其他」:悬停提示里排在最后 */
  rest?: boolean;
}

export interface DailySeries {
  days: string[];
  /** 每个面板 / 客户每天的流量(字节) */
  series: { id: number; values: number[] }[];
}

export interface PanelSnapshot {
  id: number;
  taken_at: number;
  inbounds: number;
  clients: number;
}

export interface RestorePlan {
  inbounds: { remark: string; protocol: string; port: number; action: 'add' | 'exists'; note?: string }[];
  clients: { email: string; action: 'add' | 'attach' | 'exists' | 'skip'; inbounds: string[] }[];
  xray: { same: boolean; current: { outbounds: number; rules: number }; snapshot: { outbounds: number; rules: number } };
  warnings: string[];
}

export interface RestoreStep {
  what: string;
  ok: boolean;
  error?: string;
}

export interface PanelInput {
  name?: string;
  base_url?: string;
  token?: string;
  ip?: string | null;
  provider?: string | null;
  role?: PanelRole;
  monthly_cost?: number | null;
  expire_at?: number | null;
  enabled?: boolean;
}

export interface Line {
  binding_id: number;
  panel_id: number;
  panel_name: string;
  panel_role: PanelRole;
  email: string;
  comment: string;
  enable: boolean;
  up: number;
  down: number;
  panel_total_bytes: number;
  panel_expiry_ms: number;
  last_online: number;
  missing: boolean;
  /** 落地 IP(按配置快照推算;只有客户列表接口返回) */
  exits?: LineExit[];
}

export interface UninstallLine {
  binding_id: number;
  customer_id: number;
  customer_name: string;
  panel_id: number;
  panel_name: string;
  email: string;
}

/** 卸载面板会删掉的客户线路 */
export interface UninstallPlan {
  panel: { id: number; name: string; role: PanelRole };
  /** 直接挂在这台面板上的 */
  direct: UninstallLine[];
  /** 其他面板上出口全部经过这台的 */
  through: UninstallLine[];
  /** 其他面板上只有部分出口经过这台的(不删) */
  partial: UninstallLine[];
}

export interface LineDeleteResult {
  panel: string;
  email: string;
  ok: boolean;
  missing?: boolean;
  error?: string;
}

export interface LineExit {
  ip: string;
  /** 怎么到的:本机直出 / 经某台面板 / SOCKS 名 */
  via: string;
}

/** 订阅拉取记录 */
export interface SubFetch {
  at: number;
  target: string;
  status: number;
  ua: string;
  ip: string;
}

/** 按出口开通线路:各出口在每台中转上的入站,以及客户已有的线路 */
export interface RelayPlan {
  panel_id: number;
  panel_name: string;
  inbound: { id: number; remark: string; protocol: string; port: number } | null;
  /** 没有入站时能新建:照 template 这个入站新建一个,名字 remark */
  create: { remark: string; protocol: string; template: string } | null;
  existing: { email: string; inbound: string } | null;
}

export interface ExitOption {
  key: string;
  label: string;
  relays: RelayPlan[];
}

export interface LinePlan {
  exits: ExitOption[];
  errors: { panel: string; error: string }[];
}

export interface OpenLineResult {
  panel: string;
  inbound: string;
  email: string;
  ok: boolean;
  /** 这台中转上为它新建了入站(并重启了 Xray) */
  created?: boolean;
  error?: string;
}

/** 同步到面板时每条线路的处理结果 */
export type LineAction = '流量清零' | '启用' | '停用' | '去掉面板限制';

export interface LineOpResult {
  panel: string;
  email: string;
  ok: boolean;
  /** 实际做了的修改(已一致的不改) */
  actions: LineAction[];
  error?: string;
}

export interface Customer {
  id: number;
  name: string;
  remark: string;
  monthly_price: number | null;
  quota_bytes: number;
  expire_at: number;
  status: CustomerStatus;
  state: CustomerState;
  used_up: number;
  used_down: number;
  used: number;
  remaining: number | null;
  usage_reset_at: number;
  /** 开启"每月按到期日重置流量"的时间,0 = 没开 */
  monthly_reset_at: number;
  /** 订阅链接 /sub/<token> 里的 token,每个客户一个 */
  sub_token: string;
  /** 订阅链接;未配置 SUB_BASE_URL 时为 null */
  sub_url: string | null;
  sub_fetched_at: number | null;
  /** 上次拉取订阅用的客户端(User-Agent) */
  sub_fetched_ua: string | null;
  /** 拉取记录保留期内拉订阅用过几个客户端(按 UA 区分)、来自几个 IP;只有客户列表返回 */
  sub_clients?: number;
  sub_ips?: number;
  created_at: number;
  updated_at: number;
  lines: Line[];
}

export interface CustomerInput {
  name?: string;
  monthly_reset?: boolean;
  remark?: string;
  monthly_price?: number | null;
  quota_bytes?: number;
  expire_at?: number;
  status?: CustomerStatus;
}

export interface DailyUsage {
  days: string[];
  totals: number[];
  lines: { panel_name: string; email: string; values: number[] }[];
}

export interface SubPreviewLine {
  panel_id: number;
  panel_name: string;
  email: string;
  error?: string;
  nodes: { protocol: string; name: string }[];
}

export interface ClientRow {
  panel_id: number;
  panel_name: string;
  panel_role: PanelRole;
  email: string;
  comment: string;
  enable: boolean;
  up: number;
  down: number;
  total_bytes: number;
  expiry_ms: number;
  missing: boolean;
  customer_id: number | null;
  customer_name: string | null;
}

export interface SyncRun {
  started_at: number;
  finished_at: number;
  results: { panel_id: number; panel: string; ok: boolean; clients?: number; delta_bytes?: number; resets?: number; error?: string }[];
}

export interface SyncStatus {
  busy: boolean;
  interval_sec: number;
  last_run: SyncRun | null;
}

export interface SocksCheck {
  at: number;
  ok: boolean;
  ms: number;
  /** 出口 IP 与地区(经代理访问 Cloudflare 得到) */
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
  monthly_cost: number | null;
  remark: string;
  created_at: number;
  updated_at: number;
  check: SocksCheck | null;
}

export interface SocksInput {
  name?: string;
  /** 地址(含账号密码);修改时留空 = 不改 */
  address?: string;
  monthly_cost?: number | null;
  remark?: string;
}

export interface SocksUse {
  panel: string;
  outbound_tag: string;
  /** 路由到这个出站的入站;空 = 没有路由规则在用 */
  inbound_tags: string[];
}

export interface UnregisteredSocks extends SocksUse {
  panel_id: number;
  host: string;
  port: number;
  has_auth: boolean;
}

export interface SocksUsage {
  uses: Record<number, SocksUse[]>;
  /** 主机端口对上但账号不同 */
  mismatched: Record<number, SocksUse[]>;
  unregistered: UnregisteredSocks[];
  errors: { panel: string; error: string }[];
}

/** 卸载 SOCKS 时一台面板上会改的东西 */
export interface SocksPanelPlan {
  panel_id: number;
  panel: string;
  outbounds: string[];
  /** 要删的路由规则条数(含只分流部分流量的) */
  rules: number;
  /** 主去向是它、整个删掉的入站 */
  inbounds: { id: number; remark: string; protocol: string; port: number }[];
  /** 只挂在这些入站上、一起删掉的 client */
  clients: { email: string; customer: { id: number; name: string } | null }[];
  /** 不能自动处理的原因 */
  blocked?: string;
}

export interface SocksUninstallPlan {
  socks: { id: number; name: string; host: string; port: number };
  panels: SocksPanelPlan[];
  errors: { panel: string; error: string }[];
  /** 出口经过它、但这次不删的客户线路 */
  indirect: { customer_id: number; customer_name: string; panel: string; email: string }[];
}

export interface SocksUninstallResult {
  panels: { panel: string; ok: boolean; steps: RestoreStep[] }[];
  errors: { panel: string; error: string }[];
  /** 全部面板都处理好了,已从系统移除 */
  removed: boolean;
}

/** 全体客户每日流量(总览图表) */
export interface OverallDaily {
  days: string[];
  bytes: number[];
  /** 当天有流量的客户数 */
  customers: number[];
  /** 当天其中经中转机的流量;其余是直连落地 */
  relay: number[];
}

/** 落地机开直连的计划 */
export type DirectProtocol = 'vless' | 'hysteria';

export interface DirectPlan {
  panel: { id: number; name: string; ip: string };
  protocol: DirectProtocol;
  /** 复用的入站 */
  inbound: { id: number; remark: string; port: number; clients: number } | null;
  /** 没有可复用的入站时新建:名字、照着哪个入站建、要不要重启 Xray */
  create: { remark: string; template: string; restart: boolean } | null;
  error?: string;
  /** 出口经过这台落地的客户;existing = 已有这个协议的线路;attach = 已有别的协议的 client,会挂到新入站上 */
  customers: { id: number; name: string; state: CustomerState; lines: number; existing: string | null; attach: string | null }[];
}

export interface DirectResult {
  customer: string;
  email: string;
  ok: boolean;
  /** 挂到了已有的 client 上(没另建) */
  attached?: boolean;
  error?: string;
}

/** 中转批量开线路:每位客户在用的落地在这台中转上怎么开 */
export interface RelayExitPlan {
  key: string;
  label: string;
  /** reuse 复用已有入站;create 新建入站;existing 已有;unsupported 开不了 */
  status: 'reuse' | 'create' | 'existing' | 'unsupported';
  inbound?: string;
  reason?: string;
}

export interface RelayLinesPlan {
  relay: { id: number; name: string };
  template: string | null;
  customers: { id: number; name: string; state: CustomerState; exits: RelayExitPlan[] }[];
  errors: { panel: string; error: string }[];
}

export interface RelayLineResult {
  customer: string;
  exit: string;
  inbound: string;
  email: string;
  ok: boolean;
  created?: boolean;
  error?: string;
}
