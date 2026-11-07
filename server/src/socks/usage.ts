// 扫描各面板的 Xray 配置,找出 socks 出站:哪些用了已登记的 SOCKS(按 主机+端口+账号 匹配),
// 哪些是没登记的外部 SOCKS。指向自己面板机器的 socks 出站(中转→落地的 mixed 入站)不算外部。

import type { DB } from '../db';
import { panelHosts } from '../panels/hosts';
import { listPanels, type Panel } from '../panels/repo';
import { decodeJson as decode, xrayConfig } from '../xui/json';
import { allSocks } from './repo';

export interface XrayReader {
  xraySettings(): Promise<unknown>;
  close?(): Promise<void>;
}

export interface SocksUse {
  panel: string;
  outbound_tag: string;
  /** 路由到这个出站的入站;空 = 没有路由规则在用 */
  inbound_tags: string[];
}

export interface UnregisteredSocks {
  panel_id: number;
  panel: string;
  outbound_tag: string;
  host: string;
  port: number;
  has_auth: boolean;
  inbound_tags: string[];
}

export interface SocksUsage {
  uses: Record<number, SocksUse[]>;
  /** 主机端口对上但账号不同:多半是面板上还是旧账号 */
  mismatched: Record<number, SocksUse[]>;
  unregistered: UnregisteredSocks[];
  errors: { panel: string; error: string }[];
}

interface SocksOutbound {
  tag: string;
  host: string;
  port: number;
  username: string;
  password: string;
  inbound_tags: string[];
}

/** 从面板返回的 Xray 模板里取出 socks 出站及路由到它们的入站 */
export function socksOutbounds(raw: unknown): SocksOutbound[] {
  const xray = xrayConfig(raw);
  const rules: any[] = Array.isArray(xray?.routing?.rules) ? xray.routing.rules : [];
  const out: SocksOutbound[] = [];
  for (const o of Array.isArray(xray?.outbounds) ? xray.outbounds : []) {
    if (o?.protocol !== 'socks' || !o.tag) continue;
    const server = decode(o.settings)?.servers?.[0];
    if (!server?.address || !Number(server.port)) continue;
    const user = server.users?.[0] ?? {};
    const inbound_tags = [
      ...new Set(
        rules
          .filter((r) => r?.enabled !== false && r?.outboundTag === o.tag)
          .flatMap((r): string[] => (Array.isArray(r.inboundTag) ? r.inboundTag.map(String) : [])),
      ),
    ];
    out.push({
      tag: String(o.tag),
      host: String(server.address).toLowerCase(),
      port: Number(server.port),
      username: String(user.user ?? ''),
      password: String(user.pass ?? ''),
      inbound_tags,
    });
  }
  return out;
}

export async function scanSocksUsage(db: DB, readerFor: (panel: Panel) => XrayReader): Promise<SocksUsage> {
  const socks = allSocks(db);
  const panels = listPanels(db).filter((p) => p.enabled);
  const own = new Set((await panelHosts(listPanels(db))).keys());
  const result: SocksUsage = {
    uses: Object.fromEntries(socks.map((s) => [s.id, []])),
    mismatched: {},
    unregistered: [],
    errors: [],
  };
  await Promise.all(
    panels.map(async (panel) => {
      const reader = readerFor(panel);
      try {
        for (const o of socksOutbounds(await reader.xraySettings())) {
          const use: SocksUse = { panel: panel.name, outbound_tag: o.tag, inbound_tags: o.inbound_tags };
          const sameAddr = socks.filter((s) => s.host === o.host && s.port === o.port);
          const exact = sameAddr.find((s) => s.username === o.username && s.password === o.password);
          if (exact) result.uses[exact.id].push(use);
          else if (sameAddr.length) for (const s of sameAddr) (result.mismatched[s.id] ??= []).push(use);
          else if (!own.has(o.host)) {
            result.unregistered.push({ panel_id: panel.id, ...use, host: o.host, port: o.port, has_auth: Boolean(o.username || o.password) });
          }
        }
      } catch (e) {
        result.errors.push({ panel: panel.name, error: e instanceof Error ? e.message : String(e) });
      } finally {
        await reader.close?.();
      }
    }),
  );
  const byPanel = (a: SocksUse, b: SocksUse) => a.panel.localeCompare(b.panel, 'zh-CN') || a.outbound_tag.localeCompare(b.outbound_tag);
  for (const list of [...Object.values(result.uses), ...Object.values(result.mismatched)]) list.sort(byPanel);
  result.unregistered.sort(byPanel);
  return result;
}

/** 把面板上某个 socks 出站的地址和账号取出来(登记未登记的 SOCKS 用) */
export async function readOutboundEndpoint(reader: XrayReader, tag: string) {
  try {
    const o = socksOutbounds(await reader.xraySettings()).find((x) => x.tag === tag);
    if (!o) throw new Error(`面板上找不到出站 ${tag}`);
    return { host: o.host, port: o.port, username: o.username, password: o.password };
  } finally {
    await reader.close?.();
  }
}
