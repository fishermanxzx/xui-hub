// 线路的出口与路由:每块面板只管自己。客户端默认从这块面板直出;要换出口,就选 SOCKS 页登记的一个代理
// (可以是别的机器上用户自己建的 socks / mixed 入站,也可以是第三方代理)。xui-hub 不会去别的面板上建任何东西。
// 做法:在这块面板的 Xray 配置里补一个指向该代理的 socks 出站(已有同地址同账号的就复用)和一条「这个入站 + 这个客户端(user = email)→ 该出站」
// 的规则,放在会接住这个入站流量的兜底规则之前,然后重启 Xray;规则去掉后没人用的出站一并删掉。
// 规则按客户端区分:同一个入站上的客户端可以各走各的出口,没配规则的客户端照旧按入站 / 全局的兜底规则走(一般是直出)。
// 旧版本留下的「落地面板」出口(exit_kind = panel)照常生效、能删,只是不能再新开。

import type { DB } from '../db';
import { InputError } from '../panels/repo';
import { getSocks, type SocksEndpoint } from '../socks/repo';
import { decodeJson, xrayConfig } from '../xui/json';

export const DEFAULT_TEST_URL = 'https://www.google.com/generate_204';

export interface ExitServer {
  address: string;
  port: number;
  user: string;
  pass: string;
}

export const socksServer = (s: SocksEndpoint): ExitServer => ({ address: s.host, port: s.port, user: s.username, pass: s.password });

export interface PreparedExit {
  server: ExitServer;
  label: string;
  socks_id: number;
}

export interface RouteAdmin {
  xraySettings(): Promise<unknown>;
  updateXray(xray: unknown, testUrl: string): Promise<void>;
  restartXray(): Promise<void>;
}

/** 请求里的出口:只认 SOCKS 页登记的代理 */
export function parseExitSocksId(raw: any): number {
  if (raw?.kind === 'panel') throw new InputError('不再支持把别的面板直接当出口:在那台机器上自己建一个 socks / mixed 入站,登记到 SOCKS 页,再选它当出口');
  const id = Number(raw?.socks_id);
  if (!Number.isInteger(id) || id <= 0) throw new InputError('出口要选 SOCKS 页登记的代理');
  return id;
}

export function prepareExit(db: DB, socksId: number): PreparedExit {
  const s = getSocks(db, socksId);
  if (!s) throw new InputError('SOCKS 不存在');
  return { server: socksServer(s), label: `SOCKS ${s.name}`, socks_id: s.id };
}

const serverOf = (o: any) => {
  const s = decodeJson(o?.settings) ?? {};
  const first = (s.servers ?? [])[0] ?? {};
  const u = (first.users ?? [])[0] ?? {};
  return { address: String(first.address ?? '').toLowerCase(), port: Number(first.port), user: String(u.user ?? ''), pass: String(u.pass ?? '') };
};

/** 中转上指向这个出口的 socks 出站:已有(地址、端口、账号都一致)就复用,没有就加一个;返回它的 tag */
export function ensureOutbound(xray: any, server: ExitServer): string {
  xray.outbounds = Array.isArray(xray.outbounds) ? xray.outbounds : [];
  const same = xray.outbounds.find((o: any) => {
    if (o?.protocol !== 'socks') return false;
    const v = serverOf(o);
    return v.address === server.address.toLowerCase() && v.port === server.port && v.user === server.user && v.pass === server.pass;
  });
  if (same?.tag) return String(same.tag);
  const taken = new Set(xray.outbounds.map((o: any) => String(o?.tag ?? '')));
  const base = `socks-${server.address}-${server.port}`;
  let tag = base;
  for (let i = 2; taken.has(tag); i++) tag = `${base}-${i}`;
  xray.outbounds.push({
    tag,
    protocol: 'socks',
    settings: { servers: [{ address: server.address, port: server.port, users: server.user || server.pass ? [{ user: server.user, pass: server.pass }] : [] }] },
  });
  return tag;
}

const CONDITIONS = ['domain', 'ip', 'port', 'sourcePort', 'source', 'protocol', 'attrs', 'user', 'network'];
/** 只按入站匹配(或不限入站)的兜底规则,没有别的条件 */
const plainRule = (r: any) => CONDITIONS.every((k) => r?.[k] == null || (Array.isArray(r[k]) && !r[k].length) || r[k] === '');

/**
 * 是不是我们给某个客户端加的规则:只有 inboundTag + user 两个条件。
 * 带别的条件的(比如在面板上手配的「这个客户端的流媒体走另一个出口」)不算,换出口 / 删线路都不碰它
 */
const isUserRule = (r: any, inboundTag: string, email: string) =>
  Array.isArray(r?.inboundTag) &&
  r.inboundTag.length === 1 &&
  r.inboundTag[0] === inboundTag &&
  Array.isArray(r?.user) &&
  r.user.length === 1 &&
  r.user[0] === email &&
  CONDITIONS.every((k) => k === 'user' || r[k] == null || (Array.isArray(r[k]) && !r[k].length) || r[k] === '');

/** 会接住这个入站流量的兜底规则:不限入站、或点名这个入站,且没有别的条件 */
const catchesInbound = (r: any, inboundTag: string) => r?.enabled !== false && plainRule(r) && (r?.outboundTag || r?.balancerTag) && (!r?.inboundTag?.length || r.inboundTag.includes(inboundTag));

/** 本系统加的 socks 出站(tag 是 socks-…)没有规则、负载均衡、别的出站在用了就删掉 */
function dropUnusedOutbound(xray: any, tag: unknown): void {
  if (typeof tag !== 'string' || !tag.startsWith('socks-') || !Array.isArray(xray.outbounds)) return;
  const routing = xray.routing ?? {};
  const selectors: unknown[] = [
    ...(routing.balancers ?? []).flatMap((b: any) => [...(b?.selector ?? []), b?.fallbackTag]),
    ...(xray.observatory?.subjectSelector ?? []),
    ...(xray.burstObservatory?.subjectSelector ?? []),
  ];
  const used =
    (routing.rules ?? []).some((r: any) => r?.outboundTag === tag) ||
    selectors.some((s) => typeof s === 'string' && s !== '' && tag.startsWith(s)) ||
    xray.outbounds.some((o: any) => o?.proxySettings?.tag === tag || o?.streamSettings?.sockopt?.dialerProxy === tag);
  if (!used) xray.outbounds = xray.outbounds.filter((o: any) => !(o?.tag === tag && o?.protocol === 'socks'));
}

/**
 * 让 inboundTag 入站上的 email 这个客户端走指定出口:换掉他旧的规则,新规则放在会接住这个入站的兜底规则之前。
 * 已经是这样就不动(重做一遍不会多重启一次 Xray)。返回出站 tag
 */
export function routeUserToExit(xray: any, inboundTag: string, email: string, server: ExitServer): string {
  const outTag = ensureOutbound(xray, server);
  const all: any[] = Array.isArray(xray.routing?.rules) ? xray.routing.rules : [];
  const mine = all.filter((r) => isUserRule(r, inboundTag, email));
  const catchAt = all.findIndex((r) => catchesInbound(r, inboundTag));
  if (mine.length === 1 && mine[0].outboundTag === outTag && (catchAt < 0 || all.indexOf(mine[0]) < catchAt)) return outTag;
  const rules = all.filter((r) => !mine.includes(r));
  const rule = { type: 'field', inboundTag: [inboundTag], user: [email], outboundTag: outTag };
  const at = rules.findIndex((r) => catchesInbound(r, inboundTag));
  if (at >= 0) rules.splice(at, 0, rule);
  else rules.push(rule);
  xray.routing = { ...(xray.routing ?? {}), rules };
  for (const r of mine) dropUnusedOutbound(xray, r.outboundTag);
  return outTag;
}

/**
 * 去掉这个客户端的出口(「入站 + user → 出站」那一条),流量回到这个入站的兜底规则(一般是直出)。换成直出时用。
 * 带条件的出口规则(xui-hub: 标记的)和面板上手配的规则都不动;出站没人用了随之删掉。本来就没有就返回 false
 */
export function unrouteUserExit(xray: any, inboundTag: string, email: string): boolean {
  const rules: any[] = Array.isArray(xray.routing?.rules) ? xray.routing.rules : [];
  const mine = rules.filter((r) => isUserRule(r, inboundTag, email));
  if (!mine.length) return false;
  xray.routing = { ...(xray.routing ?? {}), rules: rules.filter((r) => !mine.includes(r)) };
  for (const r of mine) dropUnusedOutbound(xray, r.outboundTag);
  return true;
}

/**
 * 这个客户端现在的出口(读回核对用):null = 没有他自己的出口规则(走兜底,即直出);
 * 否则是规则指向的出站 tag,指向 socks 出站时带上它连的地址和账号
 */
export function userExit(xray: any, inboundTag: string, email: string): { tag: string; server: ExitServer | null } | null {
  const rules: any[] = Array.isArray(xray.routing?.rules) ? xray.routing.rules : [];
  const rule = rules.find((r) => isUserRule(r, inboundTag, email));
  if (!rule) return null;
  const tag = String(rule.outboundTag ?? '');
  const out = (Array.isArray(xray.outbounds) ? xray.outbounds : []).find((o: any) => o?.tag === tag);
  if (out?.protocol !== 'socks') return { tag, server: null };
  const v = serverOf(out);
  return { tag, server: { address: v.address, port: v.port, user: v.user, pass: v.pass } };
}

/** 两个 socks 地址是不是同一个(地址不分大小写) */
export const sameServer = (a: ExitServer, b: ExitServer) => a.address.toLowerCase() === b.address.toLowerCase() && a.port === b.port && a.user === b.user && a.pass === b.pass;

/** 出口规则(lines/rules.ts)写到面板上带的 ruleTag 前缀;本系统只认、只改带它的条件规则 */
const MANAGED = 'xui-hub:';

/** 是不是本系统给这个客户端写的出口规则(带条件的那几条) */
const isManagedRule = (r: any, inboundTag: string, email: string) =>
  typeof r?.ruleTag === 'string' &&
  r.ruleTag.startsWith(MANAGED) &&
  Array.isArray(r?.inboundTag) &&
  r.inboundTag.length === 1 &&
  r.inboundTag[0] === inboundTag &&
  Array.isArray(r?.user) &&
  r.user.length === 1 &&
  r.user[0] === email;

export type ResolvedTarget = { kind: 'socks'; server: ExitServer } | { kind: 'direct' } | { kind: 'block' };

export interface ResolvedRule {
  domain: string[];
  ip: string[];
  port: string;
  network: string;
  to: ResolvedTarget;
}

/** 某种协议的出站:已有就用第一个,没有就加一个不重名的 */
function outboundOf(xray: any, protocol: 'freedom' | 'blackhole', base: string): string {
  xray.outbounds = Array.isArray(xray.outbounds) ? xray.outbounds : [];
  const found = xray.outbounds.find((o: any) => o?.protocol === protocol && typeof o?.tag === 'string' && o.tag);
  if (found) return found.tag;
  const taken = new Set(xray.outbounds.map((o: any) => o?.tag));
  let tag = base;
  for (let i = 2; taken.has(tag); i++) tag = `${base}-${i}`;
  xray.outbounds.push({ tag, protocol });
  return tag;
}

/**
 * 把这个客户端的出口规则换成 rules(空 = 去掉):按顺序放在他自己的出口规则和接住这个入站的兜底规则之前,
 * 没命中的流量照旧走原来的出口。只替换本系统写的(带 ruleTag 标记的),面板上手配的不动;旧规则用的出站没人用了就删掉
 */
export function setUserRules(xray: any, inboundTag: string, email: string, rules: ResolvedRule[]): void {
  const all: any[] = Array.isArray(xray.routing?.rules) ? xray.routing.rules : [];
  const old = all.filter((r) => isManagedRule(r, inboundTag, email));
  const rest = all.filter((r) => !old.includes(r));
  const fresh = rules.map((r, i) => {
    const outboundTag = r.to.kind === 'socks' ? ensureOutbound(xray, r.to.server) : r.to.kind === 'direct' ? outboundOf(xray, 'freedom', 'direct') : outboundOf(xray, 'blackhole', 'blocked');
    return {
      type: 'field',
      ruleTag: `${MANAGED}${inboundTag}:${email}:${i + 1}`,
      inboundTag: [inboundTag],
      user: [email],
      ...(r.domain.length ? { domain: r.domain } : {}),
      ...(r.ip.length ? { ip: r.ip } : {}),
      ...(r.port ? { port: r.port } : {}),
      ...(r.network ? { network: r.network === 'udp,tcp' ? 'tcp,udp' : r.network } : {}),
      outboundTag,
    };
  });
  const at = rest.findIndex((r) => isUserRule(r, inboundTag, email) || catchesInbound(r, inboundTag));
  if (at >= 0) rest.splice(at, 0, ...fresh);
  else rest.push(...fresh);
  xray.routing = { ...(xray.routing ?? {}), rules: rest };
  for (const r of old) dropUnusedOutbound(xray, r.outboundTag);
}

/** 去掉某个客户端的出口规则(删线路时):本系统给他加的出口规则和条件规则;用的出站没人用了也删掉。一条都没有就返回 false */
export function unrouteUser(xray: any, inboundTag: string, email: string): boolean {
  const rules: any[] = Array.isArray(xray.routing?.rules) ? xray.routing.rules : [];
  const mine = rules.filter((r) => isUserRule(r, inboundTag, email) || isManagedRule(r, inboundTag, email));
  if (!mine.length) return false;
  xray.routing = { ...(xray.routing ?? {}), rules: rules.filter((r) => !mine.includes(r)) };
  for (const r of mine) dropUnusedOutbound(xray, r.outboundTag);
  return true;
}

/** 读中转的 Xray 配置 → 改 → 有变化才写回并重启 Xray(上面所有客户端断流几秒)。返回改没改。调用方要先占住这块面板(panelKey) */
export async function editXray(admin: RouteAdmin, edit: (xray: any) => void): Promise<boolean> {
  const raw = await admin.xraySettings();
  const xray = xrayConfig(raw);
  const before = JSON.stringify(xray);
  edit(xray);
  if (JSON.stringify(xray) === before) return false;
  await admin.updateXray(xray, decodeJson(raw)?.outboundTestUrl || DEFAULT_TEST_URL);
  await admin.restartXray();
  return true;
}

/**
 * 和 editXray 一样改 Xray 配置,改完读回来交给 check 核对(不对就抛错);写回之后重启失败或核对不过,
 * 就把改之前的配置写回去再重启一次(尽力而为),再把原来的错误抛出去,免得面板上是新配置、记录还是旧的。
 * 返回读回来的配置(没改动就是读到的那份)
 */
export async function editXrayChecked(admin: RouteAdmin, edit: (xray: any) => void, check: (back: any) => void): Promise<any> {
  const raw = await admin.xraySettings();
  const xray = xrayConfig(raw);
  const original = structuredClone(xray);
  const before = JSON.stringify(xray);
  edit(xray);
  if (JSON.stringify(xray) === before) {
    check(xray);
    return xray;
  }
  const testUrl = decodeJson(raw)?.outboundTestUrl || DEFAULT_TEST_URL;
  await admin.updateXray(xray, testUrl);
  try {
    await admin.restartXray();
    const back = xrayConfig(await admin.xraySettings());
    check(back);
    return back;
  } catch (e) {
    await admin
      .updateXray(original, testUrl)
      .then(() => admin.restartXray())
      .catch(() => {});
    throw e;
  }
}

export interface UserRoute {
  inboundTag: string;
  email: string;
}

/** 去掉这些客户端的出口规则:一次写回、一次重启;一条都没有就不动 */
export function removeRoutes(admin: RouteAdmin, users: UserRoute[]): Promise<boolean> {
  return editXray(admin, (xray) => {
    for (const u of users) unrouteUser(xray, u.inboundTag, u.email);
  });
}
