// 展示格式化。文案走 i18n:这些函数在模板里调用,切换语言后跟着重算。

import { locale, t } from './i18n';
import type { RouteHop } from './types';

export function fmtBytes(n: number): string {
  if (!n) return '0';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || i === 0 ? v.toFixed(0) : v.toFixed(v >= 10 ? 1 : 2)} ${units[i]}`;
}

const GB = 1024 ** 3;
export function bytesToGb(n: number): number {
  return Math.round((n / GB) * 100) / 100;
}
export function gbToBytes(gb: number): number {
  return Math.round(gb * GB);
}

/** 可能是负数的流量(手动减过的结转) */
export const fmtSignedBytes = (n: number): string => (n < 0 ? '-' : '') + fmtBytes(Math.abs(n));

function pad(n: number): string {
  return String(n).padStart(2, '0');
}
export function fmtDate(ms: number, empty = t('fmt.noExpiry')): string {
  if (!ms) return empty;
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
/** 日期输入框的值 → 当天 23:59:59 的毫秒时间戳;空 = 0(不限期) */
export function dateInputToMs(value: string): number {
  if (!value) return 0;
  const [y, m, d] = value.split('-').map(Number);
  return new Date(y, m - 1, d, 23, 59, 59, 999).getTime();
}
/** 加 n 个自然月,日子不变;那个月没有这一天就取月底(和服务端续费一样算,预览用) */
export function addMonths(ms: number, n: number): number {
  const d = new Date(ms);
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + n);
  d.setDate(Math.min(day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()));
  return d.getTime();
}
/** 当月 1 号 0 点(本地时区),往前 / 往后 n 个月 */
export function monthStart(ms: number, n = 0): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth() + n, 1).getTime();
}
export function msToDateInput(ms: number): string {
  if (!ms) return '';
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
export const stateLabel = (state: string): string => (state === 'active' || state === 'expired' || state === 'over_quota' ? t(`state.${state}`) : state);

export function fmtAgo(ms: number | null | undefined, empty = t('fmt.never')): string {
  if (!ms) return empty;
  const diff = Date.now() - ms;
  if (diff < 60_000) return t('fmt.justNow');
  if (diff < 3_600_000) return t('fmt.minutesAgo', { n: Math.floor(diff / 60_000) });
  if (diff < 86_400_000) return t('fmt.hoursAgo', { n: Math.floor(diff / 3_600_000) });
  return t('fmt.daysAgo', { n: Math.floor(diff / 86_400_000) });
}

const DAY_MS = 86_400_000;

function startOfDay(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** 距到期还有几个自然日:今天到期 = 0,已过期为负 */
export function daysUntil(ms: number, now = Date.now()): number {
  return Math.round((startOfDay(ms) - startOfDay(now)) / DAY_MS);
}

/** 到期的说法:明天到期、3 天后、已过期 2 天、不限期 */
export function fmtDue(ms: number, now = Date.now()): string {
  if (!ms) return t('fmt.noExpiry');
  const d = daysUntil(ms, now);
  if (d < 0) return t('fmt.overdue', { n: -d });
  if (d === 0) return t('fmt.dueToday');
  if (d === 1) return t('fmt.dueTomorrow');
  return t('fmt.dueIn', { n: d });
}

/** 到期的紧急程度:已过期 err,7 天内 warn,其余不标 */
export function dueLevel(ms: number, now = Date.now()): '' | 'warn' | 'err' {
  if (!ms) return '';
  const d = daysUntil(ms, now);
  return d < 0 ? 'err' : d <= 7 ? 'warn' : '';
}

/** 到期日的颜色:7 天内黄、过期红,其余 normal(或给定的默认 class) */
export function dueClass(ms: number, normal = ''): string {
  const level = dueLevel(ms);
  return level === 'err' ? 'text-err' : level === 'warn' ? 'text-warn' : normal;
}

/** 金额:最多两位小数 */
export const fmtCost = (n: number): string => n.toLocaleString(undefined, { maximumFractionDigits: 2 });

/** 面板 / SOCKS 的成本汇总:月成本合计、没填的个数、7 天内到期和已过期的个数 */
export function costSummary(items: { monthly_cost: number | null; expire_at: number }[], now = Date.now()) {
  return {
    total: items.reduce((sum, x) => sum + Math.round((x.monthly_cost ?? 0) * 100), 0) / 100,
    unset: items.filter((x) => x.monthly_cost == null).length,
    soon: items.filter((x) => dueLevel(x.expire_at, now) === 'warn').length,
    overdue: items.filter((x) => dueLevel(x.expire_at, now) === 'err').length,
  };
}

/** 客户月费合计:已到期的不算(还没续费);再减去面板和 SOCKS 的月成本 = 结余。按分算,不出 0.1 + 0.2 那种小数 */
export function feeSummary(customers: { monthly_fee: number | null; state: string }[], costs: { monthly_cost: number | null }[]) {
  const cents = (n: number | null) => Math.round((n ?? 0) * 100);
  const paying = customers.filter((c) => c.state !== 'expired');
  const income = paying.reduce((sum, c) => sum + cents(c.monthly_fee), 0);
  const cost = costs.reduce((sum, x) => sum + cents(x.monthly_cost), 0);
  return {
    /** 有客户填了月费才显示这一行 */
    show: customers.some((c) => c.monthly_fee != null),
    income: income / 100,
    payers: paying.filter((c) => c.monthly_fee != null).length,
    unset: paying.filter((c) => c.monthly_fee == null).length,
    expired: customers.filter((c) => c.state === 'expired' && c.monthly_fee != null).length,
    /** 面板 / SOCKS 有填月成本的才算结余 */
    hasCost: costs.some((x) => x.monthly_cost != null),
    cost: cost / 100,
    balance: (income - cost) / 100,
  };
}

/** 客户的订阅链接:服务端配了 SUB_BASE_URL 用它,否则用当前打开后台的地址 */
export function subUrl(c: { sub_url: string | null; sub_token: string }): string {
  return c.sub_url ?? `${location.origin}/sub/${c.sub_token}`;
}

/** 自定义链接的完整地址:和订阅链接同一个地址前缀 */
export function customSubUrl(c: { sub_url: string | null; sub_token: string }, link: string): string {
  return subUrl(c).replace(/\/sub\/[^/]*$/, '') + link;
}

/** 订阅客户端的简称:UA 的第一段(如 clash-verge/v2.5.8),浏览器统一叫浏览器 */
export function shortUa(ua: string | null | undefined): string {
  if (!ua) return '';
  if (ua.startsWith('Mozilla/')) return t('fmt.browser');
  const first = ua.split(' ')[0];
  return first.length > 28 ? `${first.slice(0, 27)}…` : first;
}

export function fmtDateTime(ms: number | null | undefined, empty = '—'): string {
  if (!ms) return empty;
  const d = new Date(ms);
  return `${fmtDate(ms)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 出口地区:常见的给名字(按当前语言),其余原样显示代码 */
const REGIONS = new Set(['US', 'TW', 'HK', 'JP', 'SG', 'KR', 'DE', 'GB', 'NL', 'FR', 'CA', 'AU', 'MY', 'TH', 'VN', 'PH', 'IN', 'RU', 'CN']);
export function region(loc: string | null | undefined): string {
  if (!loc) return '';
  // 读一下 locale,模板里用到时切换语言会重算
  void locale.value;
  return REGIONS.has(loc) ? t(`region.${loc}` as 'region.US') : loc;
}

/** 面板地址只显示主机名和端口 */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

// ---------- 线路实际的出口(面板路由规则) ----------

/** 规则条件 → 一段短文字;列表超过 3 项只列前 3 项 */
export function routeWhen(when: Record<string, string[]>): string {
  const short = (v: string[]) => (v.length > 3 ? t('customers.routeMore', { list: v.slice(0, 3).join(', '), n: v.length }) : v.join(', '));
  const parts = Object.entries(when).map(([k, v]) => {
    if (k === 'domain' || k === 'ip') return short(v);
    if (k === 'port') return t('customers.routePort', { v: v.join(',') });
    if (k === 'sourcePort') return t('customers.routeSourcePort', { v: v.join(',') });
    if (k === 'source') return t('customers.routeSource', { v: short(v) });
    if (k === 'protocol') return t('customers.routeProtocol', { v: v.join(', ') });
    return v.join(', ');
  });
  return parts.join(' · ') || t('customers.routeRest');
}

/** 出口 → 名字:登记过的 SOCKS 用它的名字,直出 / 拦截 / 面板上的出站 / 负载均衡 */
export function routeTarget(to: RouteHop['to'], socks: { id: number; name: string }[]): string {
  if (to.kind === 'direct') return t('customers.direct');
  if (to.kind === 'block') return t('customers.routeBlock');
  if (to.kind === 'socks') return t('customers.routeSocks', { name: socks.find((s) => s.id === to.socks_id)?.name ?? to.tag });
  if (to.kind === 'balancer') return t('customers.routeBalancer', { tag: to.tag });
  if (to.kind === 'unknown') return t('customers.routeUnknown', { tag: to.tag });
  return to.address ? t('customers.routeProxyAddr', { tag: to.tag, address: to.address }) : t('customers.routeProxy', { tag: to.tag });
}

export const routeHopText = (h: RouteHop, socks: { id: number; name: string }[]) => t('customers.routeHop', { when: h.fallback ? t('customers.routeRest') : routeWhen(h.when), to: routeTarget(h.to, socks) });
