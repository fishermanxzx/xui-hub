import type { BackupInfo, ClientProtocol, CreatedClient, Customer, CustomerInput, EnforceOp, ImportResult, OpenedLine, OpenLineInput, Panel, PanelDetail, PanelInput, PanelVersions, Settings, Socks, SocksInput, SubFetch, UpdateStatus } from './types';

let onUnauthorized: (() => void) | null = null;

export function setUnauthorizedHandler(fn: () => void): void {
  onUnauthorized = fn;
}

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const rawBody = body instanceof Blob;
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'Content-Type': rawBody ? 'application/octet-stream' : 'application/json' } : undefined,
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
  subFetches: (id: number) => call<{ days: number; rows: SubFetch[] }>('GET', `/api/customers/${id}/sub-fetches`),
  /** 立即同步全部面板并执行额度 / 到期 */
  syncNow: () => call<{ ops: EnforceOp[] }>('POST', '/api/sync'),
  /** 先删掉客户在各面板上的 client(删不掉的列在 failed 里),再删客户 */
  deleteCustomer: (id: number) => call<{ failed: { line: string; error: string }[] }>('DELETE', `/api/customers/${id}`),
  openLine: (id: number, body: OpenLineInput) => call<OpenedLine>('POST', `/api/customers/${id}/lines`, body),
  lineLinks: (id: number, lineId: number) => call<{ links: string[] }>('GET', `/api/customers/${id}/lines/${lineId}/links`),
  /** force:面板上删不掉(连不上、已经不在了)也把这里的线路记录删掉 */
  deleteLine: (id: number, lineId: number, force = false) => call('DELETE', `/api/customers/${id}/lines/${lineId}${force ? '?force=1' : ''}`),
  /** 把面板上已有的客户端归到客户名下(成为直连线路),面板上不改 */
  importClients: (id: number, panelId: number, emails: string[]) => call<ImportResult>('POST', `/api/customers/${id}/lines/import`, { panel_id: panelId, emails }),

  settings: () => call<Settings>('GET', '/api/settings'),
  updateSettings: (body: Partial<Settings>) => call<Settings>('PATCH', '/api/settings', body),
  testNotify: () => call<{ results: { channel: string; ok: boolean; error?: string }[] }>('POST', '/api/settings/test'),
  /** 下载备份直接用这个地址 */
  backupUrl: '/api/backup',
  /** 上传一份 hub.db 整个换掉;成功后服务会重启 */
  restore: (file: Blob) => call<BackupInfo>('POST', '/api/restore', file),

  socks: () => call<Socks[]>('GET', '/api/socks'),
  createSocks: (body: SocksInput) => call<Socks>('POST', '/api/socks', body),
  updateSocks: (id: number, body: SocksInput) => call<Socks>('PATCH', `/api/socks/${id}`, body),
  deleteSocks: (id: number) => call('DELETE', `/api/socks/${id}`),
  checkSocks: (id: number) => call<Socks>('POST', `/api/socks/${id}/check`),
  checkAllSocks: () => call<Socks[]>('POST', '/api/socks-check-all'),
};
