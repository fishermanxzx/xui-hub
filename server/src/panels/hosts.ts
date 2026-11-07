// 自己各面板机器的地址 → 面板名:IP 字段、面板域名及其解析结果。用来认出"转到自己另一台机器"的出站。

import { promises as dns } from 'node:dns';
import type { Panel } from './repo';

const isIp = (h: string) => /^\d+\.\d+\.\d+\.\d+$/.test(h);

export async function panelHosts(panels: Panel[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  await Promise.all(
    panels.map(async (p) => {
      if (p.ip) map.set(p.ip.toLowerCase(), p.name);
      let h = '';
      try {
        h = new URL(p.base_url).hostname.toLowerCase();
      } catch {
        return;
      }
      map.set(h, p.name);
      if (!isIp(h)) for (const ip of await dns.resolve4(h).catch(() => [])) map.set(ip, p.name);
    }),
  );
  return map;
}

/** 出站里用域名指向自己面板机器的(如 us.example.com):解析后对得上面板 IP 的补进映射 */
export async function addDomainHosts(hosts: string[], map: Map<string, string>): Promise<void> {
  const names = [...new Set(hosts.map((h) => h.toLowerCase()))].filter((h) => h && !isIp(h) && !map.has(h));
  await Promise.all(
    names.map(async (h) => {
      for (const ip of await dns.resolve4(h).catch(() => [])) {
        const panel = map.get(ip);
        if (panel) map.set(h, panel);
      }
    }),
  );
}
