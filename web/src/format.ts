// 展示格式化与单位换算。

const GB = 1024 ** 3;

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

export function bytesToGb(n: number): number {
  return Math.round((n / GB) * 100) / 100;
}

export function gbToBytes(gb: number): number {
  return Math.round(gb * GB);
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

export function fmtDate(ms: number, empty = '永久'): string {
  if (!ms) return empty;
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function fmtDateTime(ms: number | null | undefined, empty = '—'): string {
  if (!ms) return empty;
  const d = new Date(ms);
  return `${fmtDate(ms)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fmtAgo(ms: number | null | undefined, empty = '从未'): string {
  if (!ms) return empty;
  const diff = Date.now() - ms;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}

/** 订阅客户端的简称:UA 的第一段(如 clash-verge/v2.5.8、Shadowrocket/3488),浏览器统一叫浏览器 */
export function shortUa(ua: string | null | undefined): string {
  if (!ua) return '';
  if (ua.startsWith('Mozilla/')) return '浏览器';
  const first = ua.split(' ')[0];
  return first.length > 28 ? `${first.slice(0, 27)}…` : first;
}

/** <input type="date"> 的值 -> 当天 23:59:59.999(本地时间);空 = 永久 */
export function dateInputToMs(value: string): number {
  if (!value) return 0;
  const [y, m, d] = value.split('-').map(Number);
  return new Date(y, m - 1, d, 23, 59, 59, 999).getTime();
}

export function msToDateInput(ms: number): string {
  return ms ? fmtDate(ms) : '';
}

export function fmtPrice(n: number | null): string {
  return n == null ? '—' : `¥${n % 1 === 0 ? n.toFixed(0) : n.toFixed(2)}`;
}

export const STATE_LABEL: Record<string, string> = {
  active: '正常',
  disabled: '已停用',
  expired: '已到期',
  over_quota: '超额',
};

export function usagePercent(used: number, quota: number): number {
  return quota > 0 ? Math.min(100, (used / quota) * 100) : 0;
}

const DAY_MS = 86_400_000;

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 距到期还有几个自然日:今天到期 = 0,已过期为负 */
export function daysUntil(ms: number, now = Date.now()): number {
  return Math.round((startOfDay(ms) - startOfDay(now)) / DAY_MS);
}

/** 到期的说法:明天到期、3 天后、已过期 2 天、不限期 */
export function fmtDue(ms: number, now = Date.now()): string {
  if (!ms) return '不限期';
  const d = daysUntil(ms, now);
  if (d < 0) return `已过期 ${-d} 天`;
  if (d === 0) return '今天到期';
  if (d === 1) return '明天到期';
  return `${d} 天后`;
}

/** 每月按到期日重置流量的下一次时间:到期日那天的 0 点,该月没有那天取最后一天 */
export function nextMonthlyReset(expireAt: number, now = Date.now()): number {
  const day = new Date(expireAt).getDate();
  const at = (y: number, m: number) => new Date(y, m, Math.min(day, new Date(y, m + 1, 0).getDate())).getTime();
  const t = new Date(now);
  const here = at(t.getFullYear(), t.getMonth());
  return here > now ? here : at(t.getFullYear(), t.getMonth() + 1);
}

/** 到期的紧急程度:已过期 err,7 天内 warn,其余不标 */
export function dueLevel(ms: number, now = Date.now()): '' | 'warn' | 'err' {
  if (!ms) return '';
  const d = daysUntil(ms, now);
  return d < 0 ? 'err' : d <= 7 ? 'warn' : '';
}
