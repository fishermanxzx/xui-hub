import type { ClientProtocol, CreatedClient, Panel, PanelDetail, PanelInput, PanelVersions, Socks, SocksInput, UpdateStatus } from './types';

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

export const api = {
  session: () => call<{ auth_required: boolean; logged_in: boolean }>('GET', '/api/session'),
  login: (password: string) => call('POST', '/api/login', { password }),
  logout: () => call('POST', '/api/logout'),

  panels: () => call<Panel[]>('GET', '/api/panels'),
  createPanel: (body: PanelInput) => call<Panel>('POST', '/api/panels', body),
  updatePanel: (id: number, body: PanelInput) => call<Panel>('PATCH', `/api/panels/${id}`, body),
  deletePanel: (id: number) => call('DELETE', `/api/panels/${id}`),
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
  deleteClient: (panelId: number, email: string) => call('DELETE', `/api/panels/${panelId}/clients/${encodeURIComponent(email)}`),

  socks: () => call<Socks[]>('GET', '/api/socks'),
  createSocks: (body: SocksInput) => call<Socks>('POST', '/api/socks', body),
  updateSocks: (id: number, body: SocksInput) => call<Socks>('PATCH', `/api/socks/${id}`, body),
  deleteSocks: (id: number) => call('DELETE', `/api/socks/${id}`),
  checkSocks: (id: number) => call<Socks>('POST', `/api/socks/${id}/check`),
  checkAllSocks: () => call<Socks[]>('POST', '/api/socks-check-all'),
};
