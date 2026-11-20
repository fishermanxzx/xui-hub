import type { RemoteBackups, RemoteResult, UpdateInfo, TrafficBy, TrafficReport, ApiToken, BackupInfo, OAuthGrant, ClientProtocol, CreatedClient, Customer, CustomerInput, EnforceOp, ImportResult, Line, OpenedLine, OpenLineInput, Panel, PanelDetail, PanelInput, PanelVersions, Settings, Socks, SocksInput, SubDevice, SubFetch, SubTemplate, UpdateStatus, LineRule } from './types';
import { locale } from './i18n';

let onUnauthorized: (() => void) | null = null;

export function setUnauthorizedHandler(fn: () => void): void {
  onUnauthorized = fn;
}

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const rawBody = body instanceof Blob;
  const res = await fetch(url, {
    method,
    // 带上界面语言:服务端按它给出错误信息
    headers: { 'Accept-Language': locale.value, ...(body !== undefined ? { 'Content-Type': rawBody ? 'application/octet-stream' : 'application/json' } : {}) },
    body: body === undefined ? undefined : rawBody ? body : JSON.stringify(body),
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

export const api = {
  session: () => call<{ auth_required: boolean; logged_in: boolean }>('GET', '/api/session'),
  login: (password: string) => call('POST', '/api/login', { password }),
  logout: () => call('POST', '/api/logout'),

  panels: () => call<Panel[]>('GET', '/api/panels'),
  createPanel: (body: PanelInput) => call<Panel>('POST', '/api/panels', body),
  updatePanel: (id: number, body: PanelInput) => call<Panel>('PATCH', `/api/panels/${id}`, body),
  /** 面板上还记着客户线路时要 force,线路记录一并删掉 */
  deletePanel: (id: number, force = false) => call('DELETE', `/api/panels/${id}${force ? '?force=1' : ''}`),
  checkPanels: () => call<Panel[]>('POST', '/api/panels/check'),
  checkPanel: (id: number) => call<Panel>('POST', `/api/panels/${id}/check`),
  panelInbounds: (id: number) => call<PanelDetail>('GET', `/api/panels/${id}/inbounds`),
  panelVersions: (id: number) => call<PanelVersions>('GET', `/api/panels/${id}/versions`),
  /** 切换 Xray 内核版本,面板会重启 Xray */
  /** 重启面板和 Xray 内核,等两个都恢复才返回 */
  restartPanel: (id: number) => call<Panel>('POST', `/api/panels/${id}/restart`),
  installXray: (id: number, version: string) => call<Panel>('POST', `/api/panels/${id}/xray/${encodeURIComponent(version)}`),
  /** 让面板升级自己;之后轮询 updateStatus */
  upgradePanel: (id: number) => call<{ run_id: string }>('POST', `/api/panels/${id}/update`),
  updateStatus: (id: number) => call<UpdateStatus>('GET', `/api/panels/${id}/update-status`),

  createClient: (panelId: number, name: string, protocol: ClientProtocol) =>
    call<CreatedClient>('POST', `/api/panels/${panelId}/clients`, { name, protocol }),
  clientLinks: (panelId: number, email: string) => call<{ links: string[] }>('GET', `/api/panels/${panelId}/clients/${encodeURIComponent(email)}/links`),
  /** 这个 client 要是某位客户的线路,线路(和它的出口规则)一并删掉 */
  deleteClient: (panelId: number, email: string) => call<{ ok: boolean; line_removed: boolean }>('DELETE', `/api/panels/${panelId}/clients/${encodeURIComponent(email)}`),

  customers: () => call<Customer[]>('GET', '/api/customers'),
  createCustomer: (body: CustomerInput) => call<Customer>('POST', '/api/customers', body),
  /** 改了额度 / 到期会立刻执行停用 / 恢复,ops 是到面板上的操作结果 */
  updateCustomer: (id: number, body: CustomerInput) => call<Customer & { ops: EnforceOp[] }>('PATCH', `/api/customers/${id}`, body),
  /** 清零已用:各线路客户端在面板上的流量清零,超额停掉的随之恢复 */
  resetUsage: (id: number) => call<Customer & { failed: { line: string; error: string }[]; ops: EnforceOp[] }>('POST', `/api/customers/${id}/reset-usage`),
  /** 重置订阅链接(换 token,旧链接立即失效) */
  resetSubToken: (id: number) => call<Customer>('POST', `/api/customers/${id}/sub-token`),
  devices: (id: number) => call<SubDevice[]>('GET', `/api/customers/${id}/devices`),
  /** 删掉一台设备,名额让出来 */
  deleteDevice: (id: number, deviceId: number) => call('DELETE', `/api/customers/${id}/devices/${deviceId}`),
  subFetches: (id: number) => call<{ days: number; rows: SubFetch[] }>('GET', `/api/customers/${id}/sub-fetches`),
  /** 立即同步全部面板并执行额度 / 到期 */
  syncNow: () => call<{ ops: EnforceOp[] }>('POST', '/api/sync'),
  /** 先删掉客户在各面板上的 client(删不掉的列在 failed 里),再删客户 */
  deleteCustomer: (id: number) => call<{ failed: { line: string; error: string }[] }>('DELETE', `/api/customers/${id}`),
  openLine: (id: number, body: OpenLineInput) => call<OpenedLine>('POST', `/api/customers/${id}/lines`, body),
  lineLinks: (id: number, lineId: number) => call<{ links: string[] }>('GET', `/api/customers/${id}/lines/${lineId}/links`),
  renameLine: (id: number, lineId: number, node_name: string) => call<Line>('PATCH', `/api/customers/${id}/lines/${lineId}`, { node_name }),
  setLineRules: (id: number, lineId: number, rules: LineRule[]) => call<Line>('PUT', `/api/customers/${id}/lines/${lineId}/rules`, { rules }),
  refreshUpstreams: (id: number) => call<Customer>('POST', `/api/customers/${id}/upstreams/refresh`),
  /** force:面板上删不掉(连不上、已经不在了)也把这里的线路记录删掉 */
  deleteLine: (id: number, lineId: number, force = false) => call('DELETE', `/api/customers/${id}/lines/${lineId}${force ? '?force=1' : ''}`),
  /** 把面板上已有的客户端归到客户名下(成为直连线路),面板上不改 */
  importClients: (id: number, panelId: number, emails: string[]) => call<ImportResult>('POST', `/api/customers/${id}/lines/import`, { panel_id: panelId, emails }),

  /** 流量统计;id 给了就展开这位客户 / 这块面板名下的各个客户端 */
  traffic: (by: TrafficBy, days: number, id?: number) => call<TrafficReport>('GET', `/api/traffic?by=${by}&days=${days}${id === undefined ? '' : `&id=${id}`}`),

  /** xui-hub 自己的版本和能不能更新;refresh 重新问一次 GitHub */
  systemVersion: (refresh = false) => call<UpdateInfo>('GET', `/api/system/version${refresh ? '?refresh=1' : ''}`),
  /** 发起更新到最新版(更新在后台跑,期间服务会重启) */
  systemUpdate: () => call<{ started: boolean }>('POST', '/api/system/update'),

  subTemplates: () => call<{ default: string; templates: SubTemplate[] }>('GET', '/api/sub-templates'),

  settings: () => call<Settings>('GET', '/api/settings'),
  updateSettings: (body: Partial<Settings>) => call<Settings>('PATCH', '/api/settings', body),
  testNotify: () => call<{ results: { channel: string; ok: boolean; error?: string }[] }>('POST', '/api/settings/test'),
  tokens: () => call<ApiToken[]>('GET', '/api/tokens'),
  createToken: (name: string) => call<ApiToken>('POST', '/api/tokens', { name }),
  deleteToken: (id: number) => call('DELETE', `/api/tokens/${id}`),
  oauthGrants: () => call<OAuthGrant[]>('GET', '/api/oauth-grants'),
  /** 撤销一个 MCP 应用的授权,它手里的令牌立即失效 */
  revokeGrant: (id: number) => call('DELETE', `/api/oauth-grants/${id}`),
  /** 下载备份直接用这个地址 */
  backupUrl: '/api/backup',
  /** 上传一份 hub.db 整个换掉;成功后服务会重启 */
  restore: (file: Blob) => call<BackupInfo>('POST', '/api/restore', file),
  remoteBackups: () => call<RemoteBackups>('GET', '/api/backup/remote'),
  remoteBackupNow: () => call<RemoteResult>('POST', '/api/backup/remote'),
  remoteRestore: (key: string) => call<BackupInfo>('POST', '/api/backup/remote/restore', { key }),

  socks: () => call<Socks[]>('GET', '/api/socks'),
  createSocks: (body: SocksInput) => call<Socks>('POST', '/api/socks', body),
  updateSocks: (id: number, body: SocksInput) => call<Socks>('PATCH', `/api/socks/${id}`, body),
  deleteSocks: (id: number) => call('DELETE', `/api/socks/${id}`),
  checkSocks: (id: number) => call<Socks>('POST', `/api/socks/${id}/check`),
  checkAllSocks: () => call<Socks[]>('POST', '/api/socks-check-all'),
};
