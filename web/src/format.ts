// 展示格式化。

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
export function fmtDate(ms: number, empty = '不限期'): string {
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
export const STATE_LABEL: Record<string, string> = { active: '正常', expired: '已到期', over_quota: '已超额' };

export function fmtAgo(ms: number | null | undefined, empty = '从未'): string {
  if (!ms) return empty;
  const diff = Date.now() - ms;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
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
  if (!ms) return '不限期';
  const d = daysUntil(ms, now);
  if (d < 0) return `已过期 ${-d} 天`;
  if (d === 0) return '今天到期';
  if (d === 1) return '明天到期';
  return `${d} 天后`;
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

/** 订阅客户端的简称:UA 的第一段(如 clash-verge/v2.5.8),浏览器统一叫浏览器 */
export function shortUa(ua: string | null | undefined): string {
  if (!ua) return '';
  if (ua.startsWith('Mozilla/')) return '浏览器';
  const first = ua.split(' ')[0];
  return first.length > 28 ? `${first.slice(0, 27)}…` : first;
}

export function fmtDateTime(ms: number | null | undefined, empty = '—'): string {
  if (!ms) return empty;
  const d = new Date(ms);
  return `${fmtDate(ms)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 出口地区:常见的给中文名,其余原样显示代码 */
const REGION: Record<string, string> = {
  US: '美国', TW: '台湾', HK: '香港', JP: '日本', SG: '新加坡', KR: '韩国', DE: '德国', GB: '英国',
  NL: '荷兰', FR: '法国', CA: '加拿大', AU: '澳大利亚', MY: '马来西亚', TH: '泰国', VN: '越南', PH: '菲律宾', IN: '印度', RU: '俄罗斯', CN: '中国',
};
export function region(loc: string | null | undefined): string {
  return loc ? (REGION[loc] ?? loc) : '';
}

/** 面板地址只显示主机名和端口 */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
