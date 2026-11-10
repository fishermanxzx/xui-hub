// 测试辅助:内存数据库、面板构造和假面板。

import { openDb, type DB } from './db';
import type { PanelClient } from './http/routes';
import { createPanel, type Panel } from './panels/repo';

export function memoryDb(): DB {
  return openDb(':memory:');
}

export function addPanel(db: DB, name: string, baseUrl = `https://${name}.example:2053/path`): Panel {
  return createPanel(db, { name, base_url: baseUrl, token: 't' }, 0);
}

export const reality = { network: 'tcp', security: 'reality', realitySettings: { target: 'x:443', serverNames: ['x'], privateKey: 'k', shortIds: ['ab'], settings: { publicKey: 'pub' } } };
export const vlessInbound = (id: number, port: number) => ({ id, remark: `v${id}`, protocol: 'vless', port, enable: true, tag: `in-${port}`, streamSettings: reality });
/** 中转面板最初的 Xray 配置:一个直连出站、一条兜底规则 */
export const relayXray = () => ({ outbounds: [{ tag: 'direct', protocol: 'freedom' }], routing: { rules: [{ type: 'field', outboundTag: 'direct' }] } });

/**
 * 一块假面板的状态。fail:让某个方法报错(给字符串就是普通 Error,也可以直接给错误对象);
 * slow:读 Xray 配置慢一点(毫秒),用来撞并发;update:面板报的可升级信息
 */
export type FakePanel = {
  inbounds: any[];
  clients: any[];
  xray: any;
  cert?: string;
  restarts: number;
  fail?: Partial<Record<keyof PanelClient, string | Error>>;
  slow?: number;
  update?: { channel: string; current: string; latest: string; available: boolean } | null;
};

/** 按面板名取状态的假面板;fail 在每次取客户端时读,测试中途可以改 */
export function fakePanels(data: Record<string, FakePanel>) {
  return (p: Panel): PanelClient => {
    const d = data[p.name];
    const client: PanelClient = {
      listInbounds: async () => structuredClone(d.inbounds),
      listClients: async () => structuredClone(d.clients),
      clientLinks: async (email) => d.clients.filter((c) => c.email === email).map((c) => `vless://${c.id}@${new URL(p.base_url).hostname}#${email}`),
      addClient: async (client: any, inboundIds) => void d.clients.push({ ...client, inboundIds }),
      deleteClient: async (email) => void (d.clients = d.clients.filter((c) => c.email !== email)),
      setClientsEnabled: async (emails, enable) => d.clients.filter((c) => emails.includes(c.email)).forEach((c) => (c.enable = enable)),
      resetClientTraffic: async (email) => d.clients.filter((c) => c.email === email).forEach((c) => (c.traffic = { ...c.traffic, up: 0, down: 0 })),
      addInbound: async (body: any) => void d.inbounds.push({ ...structuredClone(body), id: d.inbounds.length + 1, tag: `in-${body.port}` }),
      deleteInbound: async (id) => void (d.inbounds = d.inbounds.filter((i) => i.id !== id)),
      panelCert: async () => ({ certFile: d.cert ?? '', keyFile: d.cert ?? '' }),
      xraySettings: async () => {
        const xraySetting = JSON.stringify(d.xray);
        if (d.slow) await new Promise((r) => setTimeout(r, d.slow));
        return { xraySetting };
      },
      updateXray: async (x: any) => void (d.xray = structuredClone(x)),
      restartXray: async () => void d.restarts++,
      serverStatus: async () => ({ panelVersion: '3.0.0', xrayVersion: '25.1.1', xrayState: 'running', xrayError: '' }),
      xrayVersions: async () => ['v25.1.1'],
      panelUpdateInfo: async () => d.update ?? null,
      installXray: async () => {},
      updatePanel: async () => 'run-1',
      updateStatus: async () => ({ runId: 'run-1', state: 'success', exitCode: 0 }),
    };
    for (const [method, error] of Object.entries(d.fail ?? {})) (client as any)[method] = async () => Promise.reject(typeof error === 'string' ? new Error(error) : error);
    return client;
  };
}
