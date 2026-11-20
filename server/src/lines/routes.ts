// 读面板的 Xray 路由,看一条线路(某个入站上的某个客户端)的流量实际从哪些出口出去:只读,不改面板。
// 同一个客户端可以在面板上按规则配多个出口(比如流媒体走 A、其余走 B),这里按规则顺序列出来:
// - 点名这个客户端(user 里有他的 email)且入站对得上的规则,带的条件(域名、IP、端口…)和去向;
// - 最后没被这些规则接住的流量走哪(第一条接住这个入站的兜底规则;都没有就是 Xray 的第一个出站)。
// 不点名客户端、带条件的全局规则(如屏蔽 bittorrent、私有 IP)对谁都一样,不列。
// 出口是 SOCKS 页登记过的(地址、端口对得上)就认成那个 SOCKS。

import { decodeJson } from '../xui/json';

/** 规则里会限定流量的条件(user 和 inboundTag 单独看) */
const CONDITION_KEYS = ['domain', 'ip', 'port', 'sourcePort', 'source', 'protocol', 'attrs', 'network'] as const;
export type ConditionKey = (typeof CONDITION_KEYS)[number];

export type RouteTargetKind = 'direct' | 'block' | 'socks' | 'proxy' | 'balancer' | 'unknown';

export interface RouteTarget {
  kind: RouteTargetKind;
  /** 面板上的出站 tag(负载均衡是 balancer 的 tag) */
  tag: string;
  /** 出站连的地址(socks / http / 代理协议),host:port */
  address?: string;
  /** 认成了 SOCKS 页登记的哪个 */
  socks_id?: number;
}

export interface RouteHop {
  /** 这一跳的条件;空 = 其余所有流量 */
  when: Partial<Record<ConditionKey, string[]>>;
  to: RouteTarget;
  /** 兜底(其余所有流量) */
  fallback: boolean;
}

export interface KnownSocks {
  id: number;
  host: string;
  port: number;
}

const list = (v: unknown): string[] => {
  if (v == null || v === '') return [];
  if (Array.isArray(v)) return v.map(String).filter(Boolean);
  if (typeof v === 'object') return Object.entries(v as Record<string, unknown>).map(([k, x]) => `${k}=${x}`);
  return String(v)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
};

function conditionsOf(rule: any): Partial<Record<ConditionKey, string[]>> {
  const out: Partial<Record<ConditionKey, string[]>> = {};
  for (const k of CONDITION_KEYS) {
    const v = list(rule?.[k]);
    if (v.length) out[k] = v;
  }
  return out;
}

/** 出站连向的地址(socks / http 的 servers,代理协议的 vnext / servers) */
function addressOf(o: any): { host: string; port: number } | undefined {
  const s = decodeJson(o?.settings) ?? {};
  const first = (s.servers ?? s.vnext ?? [])[0];
  if (first?.address) return { host: String(first.address).toLowerCase(), port: Number(first.port) };
  if (s.address) return { host: String(s.address).toLowerCase(), port: Number(s.port) };
  return undefined;
}

function targetOf(xray: any, rule: any, socks: KnownSocks[]): RouteTarget {
  if (!rule?.outboundTag && rule?.balancerTag) return { kind: 'balancer', tag: String(rule.balancerTag) };
  const tag = String(rule?.outboundTag ?? '');
  const o = (Array.isArray(xray?.outbounds) ? xray.outbounds : []).find((x: any) => x?.tag === tag);
  return outboundTarget(o, tag, socks);
}

function outboundTarget(o: any, tag: string, socks: KnownSocks[]): RouteTarget {
  if (!o) return { kind: 'unknown', tag };
  const protocol = String(o.protocol ?? '');
  if (protocol === 'freedom') return { kind: 'direct', tag };
  if (protocol === 'blackhole') return { kind: 'block', tag };
  const at = addressOf(o);
  const address = at ? `${at.host}:${at.port}` : undefined;
  if (at && (protocol === 'socks' || protocol === 'http')) {
    const known = socks.find((s) => s.host.toLowerCase() === at.host && s.port === at.port);
    if (known) return { kind: 'socks', tag, address, socks_id: known.id };
  }
  return { kind: 'proxy', tag, ...(address ? { address } : {}) };
}

const enabled = (r: any) => r && r.enabled !== false;
const hasInbound = (r: any, inboundTag: string) => !list(r.inboundTag).length || list(r.inboundTag).includes(inboundTag);

/**
 * 某个入站上某个客户端的出口,按规则顺序。读不到配置时返回空数组
 * @param raw 面板 POST /xray/ 的返回或 Xray 配置对象
 */
export function routesForClient(xray: any, inboundTag: string, email: string, socks: KnownSocks[]): RouteHop[] {
  const rules: any[] = Array.isArray(xray?.routing?.rules) ? xray.routing.rules : [];
  const hops: RouteHop[] = [];
  for (const r of rules) {
    if (!enabled(r) || !hasInbound(r, inboundTag)) continue;
    const users = list(r.user);
    if (users.length && !users.includes(email)) continue;
    const when = conditionsOf(r);
    const conditional = Object.keys(when).length > 0;
    if (users.length) {
      // 点名这个客户端的规则:带条件的列出来接着看;不带条件的就是他的兜底,后面的规则轮不到
      hops.push({ when, to: targetOf(xray, r, socks), fallback: !conditional });
      if (!conditional) return hops;
    } else if (!conditional) {
      // 接住这个入站全部流量的规则:其余流量都走它
      hops.push({ when: {}, to: targetOf(xray, r, socks), fallback: true });
      return hops;
    }
  }
  // 没有规则接住:Xray 用第一个出站
  const first = Array.isArray(xray?.outbounds) ? xray.outbounds[0] : undefined;
  if (first) hops.push({ when: {}, to: outboundTarget(first, String(first.tag ?? ''), socks), fallback: true });
  return hops;
}
