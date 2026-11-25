// 地球上的点(面板页、SOCKS 页共用)和「遍布哪些地区」的汇总。

export interface GlobePoint {
  id: number;
  name: string;
  lat: number;
  lng: number;
  /** 城市 / 地点名;country 是两位国家 / 地区代码,手动填的可能为空 */
  city: string;
  country: string;
  /** 不通(面板连不上 / SOCKS 测试失败):红点 */
  down: boolean;
  /** 悬停提示里名字后面那一串(IP、客户端数……) */
  meta: string;
}

/** 国家 / 地区代码的显示名,香港、澳门不用「中国香港特别行政区」这么长的写法 */
const SHORT: Record<string, Record<string, string>> = { zh: { HK: '香港', MO: '澳门' }, en: { HK: 'Hong Kong', MO: 'Macao' } };

export function regionName(code: string, lang: string): string {
  const c = code.toUpperCase();
  const short = SHORT[lang]?.[c];
  if (short) return short;
  try {
    return new Intl.DisplayNames([lang], { type: 'region' }).of(c) ?? c;
  } catch {
    return c;
  }
}

/** 按国家 / 地区汇总,多的在前;没有国家代码的(手动填的坐标)按地点名算 */
export function regionsOf(points: { country: string; city: string }[], lang: string): { name: string; n: number }[] {
  const count = new Map<string, number>();
  for (const p of points) {
    const name = p.country ? regionName(p.country, lang) : p.city || '?';
    count.set(name, (count.get(name) ?? 0) + 1);
  }
  return [...count].map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n || a.name.localeCompare(b.name, lang));
}

/** 表单里填的坐标「纬度, 经度」(逗号 / 中文逗号 / 空格分开);写得不对 = null */
export function parseCoords(text: string): { lat: number; lng: number } | null {
  const m = text.trim().match(/^(-?\d+(?:\.\d+)?)\s*[,,\s]\s*(-?\d+(?:\.\d+)?)$/);
  return m ? { lat: Number(m[1]), lng: Number(m[2]) } : null;
}
