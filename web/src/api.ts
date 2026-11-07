import type {
  ClientRow,
  Customer,
  CustomerInput,
  DailySeries,
  DailyUsage,
  LineDeleteResult,
  LineOpResult,
  LinePlan,
  OpenLineResult,
  OverallDaily,
  Panel,
  PanelDetail,
  PanelInput,
  PanelSnapshot,
  RestorePlan,
  RestoreStep,
  Socks,
  SocksInput,
  SocksUninstallPlan,
  SocksUninstallResult,
  SocksUsage,
  SubFetch,
  SubPreviewLine,
  SyncRun,
  SyncStatus,
  UninstallPlan,
  DirectPlan,
  DirectProtocol,
  DirectResult,
  RelayLineResult,
  RelayLinesPlan,
} from './types';

let onUnauthorized: (() => void) | null = null;

export function setUnauthorizedHandler(fn: () => void): void {
  onUnauthorized = fn;
}

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* 非 JSON 错误页 */
  }
  if (res.status === 401 && !url.endsWith('/login')) onUnauthorized?.();
  if (!res.ok) throw new Error(data?.error || text || `HTTP ${res.status}`);
  return data as T;
}

/** 每日流量统计里排除的面板:?exclude=1,2 */
function excludeQuery(exclude: readonly number[]): string {
  return exclude.length ? `&exclude=${exclude.join(',')}` : '';
}

export const api = {
  session: () => call<{ auth_required: boolean; logged_in: boolean }>('GET', '/api/session'),
  login: (password: string) => call('POST', '/api/login', { password }),
  logout: () => call('POST', '/api/logout'),

  panels: () => call<Panel[]>('GET', '/api/panels'),
  createPanel: (body: PanelInput) => call<Panel>('POST', '/api/panels', body),
  updatePanel: (id: number, body: PanelInput) => call<Panel>('PATCH', `/api/panels/${id}`, body),
  uninstallPlan: (id: number) => call<UninstallPlan>('GET', `/api/panels/${id}/uninstall-plan`),
  /** 删除客户线路的 client 并解绑,再把面板从系统移除 */
  uninstallPanel: (id: number) => call<{ plan: UninstallPlan; results: LineDeleteResult[] }>('POST', `/api/panels/${id}/uninstall`),
  /** 中转批量开线路:勾选客户,按各自在用的落地在这台中转上开线路 */
  relayPlan: (id: number) => call<RelayLinesPlan>('GET', `/api/panels/${id}/relay-plan`),
  openRelayLines: (id: number, customerIds: number[]) =>
    call<{ created: string[]; results: RelayLineResult[] }>('POST', `/api/panels/${id}/relay-lines`, { customer_ids: customerIds }),
  /** 落地机开直连:出口经过它的客户,在落地上直接开 vless 线路 */
  directPlan: (id: number, protocol: DirectProtocol) => call<DirectPlan>('GET', `/api/panels/${id}/direct-plan?protocol=${protocol}`),
  openDirect: (id: number, customerIds: number[], protocol: DirectProtocol) =>
    call<{ created: string | null; results: DirectResult[] }>('POST', `/api/panels/${id}/direct-lines`, { customer_ids: customerIds, protocol }),
  panelInbounds: (id: number) => call<PanelDetail>('GET', `/api/panels/${id}/inbounds`),
  panelSnapshots: (id: number) =>
    call<{ keep_days: number; keep_latest: number; rows: PanelSnapshot[] }>('GET', `/api/panels/${id}/snapshots`),
  /** 立即读一遍面板存快照;和最新一份一样就不存(stored = false) */
  takeSnapshot: (id: number) => call<{ stored: boolean }>('POST', `/api/panels/${id}/snapshots`),
  restorePlan: (id: number, snapshotId: number) => call<RestorePlan>('GET', `/api/panels/${id}/snapshots/${snapshotId}/plan`),
  restoreSnapshot: (id: number, snapshotId: number, xray: boolean) =>
    call<{ steps: RestoreStep[] }>('POST', `/api/panels/${id}/snapshots/${snapshotId}/restore`, { xray }),

  syncStatus: () => call<SyncStatus>('GET', '/api/sync'),
  runSync: () => call<SyncRun>('POST', '/api/sync/run'),

  customers: () => call<Customer[]>('GET', '/api/customers'),
  /** exclude:不算这些面板上的流量 */
  statsDaily: (days = 30, exclude: readonly number[] = []) =>
    call<OverallDaily>('GET', `/api/stats/daily?days=${days}${excludeQuery(exclude)}`),
  /** 每日流量按面板 / 按客户拆开 */
  statsDailyBy: (by: 'panels' | 'customers', days = 30, exclude: readonly number[] = []) =>
    call<DailySeries>('GET', `/api/stats/daily/${by}?days=${days}${excludeQuery(exclude)}`),
  customer: (id: number, days = 14) =>
    call<{ customer: Customer; daily: DailyUsage }>('GET', `/api/customers/${id}?days=${days}`),
  subPreview: (id: number) => call<SubPreviewLine[]>('GET', `/api/customers/${id}/sub-preview`),
  subFetches: (id: number) => call<{ days: number; rows: SubFetch[] }>('GET', `/api/customers/${id}/sub-fetches`),
  createCustomer: (body: CustomerInput) => call<Customer>('POST', '/api/customers', body),
  /** 客户进出"正常"时,panel_ops 是到面板上启停各线路的结果 */
  updateCustomer: (id: number, body: CustomerInput) =>
    call<Customer & { panel_ops?: LineOpResult[] }>('PATCH', `/api/customers/${id}`, body),
  /** 先删掉客户在各面板上的 client,再删除客户和线路绑定;有 client 删不掉时不删客户并报错 */
  deleteCustomer: (id: number) =>
    call<{ lines: LineDeleteResult[] }>('DELETE', `/api/customers/${id}`),
  /** 重置订阅链接(换 token,旧链接立即失效) */
  resetSubToken: (id: number) => call<Customer>('POST', `/api/customers/${id}/sub-token`),
  resetUsage: (id: number) =>
    call<{ customer: Customer; lines: LineOpResult[] }>('POST', `/api/customers/${id}/reset-usage`),
  renew: (id: number, months: number, resetUsage: boolean) =>
    call<{ customer: Customer; lines: LineOpResult[] }>('POST', `/api/customers/${id}/renew`, { months, reset_usage: resetUsage }),
  linePlan: (id: number) => call<LinePlan>('GET', `/api/customers/${id}/line-plan`),
  openLines: (id: number, exit: string, panelIds: number[]) =>
    call<{ customer: Customer; results: OpenLineResult[] }>('POST', `/api/customers/${id}/open-lines`, { exit, panel_ids: panelIds }),
  addBinding: (id: number, body: { panel_id: number; email: string; include_current_usage: boolean }) =>
    call<Customer>('POST', `/api/customers/${id}/bindings`, body),
  removeBinding: (id: number, bindingId: number) => call<Customer>('DELETE', `/api/customers/${id}/bindings/${bindingId}`),

  socks: () => call<Socks[]>('GET', '/api/socks'),
  createSocks: (body: SocksInput) => call<Socks>('POST', '/api/socks', body),
  updateSocks: (id: number, body: SocksInput) => call<Socks>('PATCH', `/api/socks/${id}`, body),
  deleteSocks: (id: number) => call('DELETE', `/api/socks/${id}`),
  socksUninstallPlan: (id: number) => call<SocksUninstallPlan>('GET', `/api/socks/${id}/uninstall-plan`),
  /** 删各面板上指向它的出站、路由和入站,全部成功后从系统移除 */
  uninstallSocks: (id: number) => call<SocksUninstallResult>('POST', `/api/socks/${id}/uninstall`),
  /** 卸载进度:请求断了(自己的代理走被重启的面板)时用它等结果 */
  socksUninstallStatus: (id: number) =>
    call<{ running: boolean; result: SocksUninstallResult | null }>('GET', `/api/socks/${id}/uninstall-status`),
  checkSocks: (id: number) => call<Socks>('POST', `/api/socks/${id}/check`),
  checkAllSocks: () => call<Socks[]>('POST', '/api/socks-check-all'),
  socksUsage: () => call<SocksUsage>('GET', '/api/socks-usage'),
  /** 登记面板上未登记的 SOCKS 出站(地址和账号由服务端从面板配置读取) */
  adoptSocks: (body: { panel_id: number; outbound_tag: string; name: string; monthly_cost?: number | null }) =>
    call<Socks>('POST', '/api/socks-adopt', body),

  clients: (unboundOnly = false) => call<ClientRow[]>('GET', `/api/clients${unboundOnly ? '?unbound=1' : ''}`),
};
