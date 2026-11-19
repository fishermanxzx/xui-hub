// 展示格式化。文案走 i18n:这些函数在模板里调用,切换语言后跟着重算。

import { locale, t } from './i18n';

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
