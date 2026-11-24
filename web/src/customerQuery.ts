// 客户页的搜索 / 过滤 / 排序(纯前端:客户列表本来就整个取回来)。

import { dueLevel } from './format';
import type { Customer, Line, Panel, Socks } from './types';

export type CustomerSort = 'name' | 'expire' | 'used' | 'fee' | 'created' | 'fetched';
/** '' = 全部;soon = 7 天内到期(还没到期);lines_off = 客户正常,但有线路停着(面板上被停了、或面板上已经没这个客户端) */
export type CustomerStateFilter = '' | 'active' | 'soon' | 'over_quota' | 'expired' | 'lines_off';
export const CUSTOMER_SORTS: CustomerSort[] = ['name', 'expire', 'used', 'fee', 'created', 'fetched'];
export const CUSTOMER_STATES: Exclude<CustomerStateFilter, ''>[] = ['active', 'soon', 'over_quota', 'expired', 'lines_off'];

/** 数量筛选:'' = 不限;'0'…'4' = 正好这么多;'5+' = 5 个及以上 */
export type CountFilter = '' | '0' | '1' | '2' | '3' | '4' | '5+';
export const COUNT_FILTERS: Exclude<CountFilter, ''>[] = ['0', '1', '2', '3', '4', '5+'];
export const matchCount = (n: number, f: CountFilter) => !f || (f === '5+' ? n >= 5 : n === Number(f));

export interface CustomerQuery {
  /** 搜名字、备注、线路 email、节点名 */
  q: string;
  /** 有线路在这些面板上(任一块;中转线路的入口和出口面板都算) */
  panels: number[];
  state: CustomerStateFilter;
  /** 有线路在带这些标签的面板上(任一个标签;中转线路的入口和出口面板都算) */
  tags: string[];
  /** 线路条数 */
  lines: CountFilter;
  /** 落地 IP 个数(见 exitIps) */
  exits: CountFilter;
  sort: CustomerSort;
  /** 反过来排 */
  reverse: boolean;
}

/** 各排序默认的方向:名字 A→Z、到期日近的在前;流量 / 月费 / 新建 / 拉订阅都是大的(新的)在前 */
const DESC: Record<CustomerSort, boolean> = { name: false, expire: false, used: true, fee: true, created: true, fetched: true };
/** 排序用的值;null = 没有(不限期、没填月费、没拉过订阅),不管正着反着都排最后 */
const KEY: Record<CustomerSort, (c: Customer) => number | string | null> = {
  name: (c) => c.name,
  expire: (c) => c.expire_at || null,
  used: (c) => c.used,
  fee: (c) => c.monthly_fee,
  created: (c) => c.created_at,
  fetched: (c) => c.sub_fetched_at || null,
};

/** 名字按中文排(汉字按拼音,字母不分大小写,数字按大小),不随浏览器语言变 */
const collator = new Intl.Collator('zh', { numeric: true, sensitivity: 'base' });
const byName = (a: Customer, b: Customer) => collator.compare(a.name, b.name) || a.id - b.id;

export const usesPanel = (c: Customer, ids: Set<number>) => c.lines.some((l) => ids.has(l.panel_id) || (l.exit_panel_id != null && ids.has(l.exit_panel_id)));

export function matchState(c: Customer, state: CustomerStateFilter, now = Date.now()): boolean {
  if (state === 'soon') return c.state !== 'expired' && dueLevel(c.expire_at, now) === 'warn';
  // 超额 / 到期的客户线路本来就是被停的,不算在这里
  if (state === 'lines_off') return c.state === 'active' && c.lines.some((l) => !l.enable);
  return !state || c.state === state;
}

/** 面板的 IP:检查时解析出来的,还没解析就用地址里的主机名 */
export function panelIp(p: Pick<Panel, 'ip' | 'base_url'>): string {
  if (p.ip) return p.ip;
  try {
    return new URL(p.base_url).hostname.replace(/^\[|\]$/g, '');
  } catch {
    return '';
  }
}
/** SOCKS 的出口 IP:测过就用测到的,没测过用它的地址 */
export const socksIp = (s: Pick<Socks, 'host' | 'check'>) => s.check?.ip || s.host;
const hostOf = (address: string) => address.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');

/**
 * 一条线路主出口落地的 IP(没被出口规则接住的流量从哪个 IP 出去);拦截 / 认不出返回 ''。
 * 中转到另一块面板 → 那块面板的 IP;出口是 SOCKS → SOCKS 的出口 IP;直出 → 所在面板的 IP。
 * 面板上实际的出口读到了就按实际的算,带条件的规则(如流媒体单走)不算。
 */
export function lineExitIp(l: Line, panels: Map<number, Panel>, socks: Map<number, Socks>): string {
  const ipOfPanel = (id: number | null | undefined) => {
    const p = id != null ? panels.get(id) : undefined;
    return p ? panelIp(p) : '';
  };
  const ipOfSocks = (id: number | null | undefined) => {
    const s = id != null ? socks.get(id) : undefined;
    return s ? socksIp(s) : '';
  };
  if (l.kind === 'relay' && l.exit_kind === 'panel') return ipOfPanel(l.exit_panel_id);
  const hop = l.routes?.find((h) => h.fallback);
  if (hop) {
    const to = hop.to;
    if (to.socks_id != null) return ipOfSocks(to.socks_id) || (to.address ? hostOf(to.address) : '');
    if (to.kind === 'direct') return ipOfPanel(l.panel_id);
    if (to.address) {
      // 连到了另一块登记过的面板(按地址认),落地就是那块面板
      const host = hostOf(to.address);
      for (const p of panels.values()) if (p.ip === host || panelIp(p) === host) return panelIp(p);
      return host;
    }
    return '';
  }
  if (l.kind === 'relay' && l.exit_kind === 'socks') return ipOfSocks(l.exit_socks_id);
  return l.kind === 'direct' ? ipOfPanel(l.panel_id) : '';
}

/** 客户所有线路的落地 IP(去重) */
export function exitIps(c: Customer, panels: Map<number, Panel>, socks: Map<number, Socks>): string[] {
  return [...new Set(c.lines.map((l) => lineExitIp(l, panels, socks)).filter(Boolean))];
}

/** 带这些标签(任一个)的面板 id */
export function panelsTagged(panels: Iterable<Panel>, tags: string[]): Set<number> {
  const want = new Set(tags);
  return new Set([...panels].filter((p) => p.tags?.some((t) => want.has(t))).map((p) => p.id));
}

/** 按标签 / 落地 IP 筛选要用的面板、SOCKS 列表 */
export interface QueryContext {
  panels: Panel[];
  socks: Socks[];
}

export function queryCustomers(list: Customer[], f: CustomerQuery, now = Date.now(), ctx: QueryContext = { panels: [], socks: [] }): Customer[] {
  const q = f.q.trim().toLowerCase();
  const panels = new Set(f.panels);
  const tagged = f.tags.length ? panelsTagged(ctx.panels, f.tags) : null;
  const pm = new Map(ctx.panels.map((p) => [p.id, p]));
  const sm = new Map(ctx.socks.map((s) => [s.id, s]));
  const shown = list.filter(
    (c) =>
      (!q || [c.name, c.remark, ...c.lines.flatMap((l) => [l.email, l.node_name])].some((s) => s?.toLowerCase().includes(q))) &&
      (!panels.size || usesPanel(c, panels)) &&
      (!tagged || usesPanel(c, tagged)) &&
      matchState(c, f.state, now) &&
      matchCount(c.lines.length, f.lines) &&
      (!f.exits || matchCount(exitIps(c, pm, sm).length, f.exits)),
  );
  const key = KEY[f.sort];
  const flip = DESC[f.sort] !== f.reverse;
  return shown.sort((a, b) => {
    const x = key(a);
    const y = key(b);
    if (x == null || y == null) return x == null && y == null ? byName(a, b) : x == null ? 1 : -1;
    const d = typeof x === 'string' ? collator.compare(x, String(y)) : x - (y as number);
    return (flip ? -d : d) || byName(a, b);
  });
}
