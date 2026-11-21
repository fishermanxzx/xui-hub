// 出口规则里 geo 写法的小工具(照 3x-ui 的 geoTokens):
// - geosite.dat / geoip.dat 里的分类写成简写 geosite:xxx / geoip:xxx,别的库写 ext:库名:分类;
// - 比较时把长写法 ext:geosite.dat:xxx 折成简写、忽略大小写(Xray 也这么认),框里原样保留用户写的。
import type { GeoKind } from './types';

const LONG_FORMS: [RegExp, string][] = [
  [/^ext(?:-domain|-site)?:geosite\.dat:/, 'geosite:'],
  [/^ext(?:-ip)?:geoip\.dat:/, 'geoip:'],
];

/** 框里的内容 → 一项项(换行、逗号都算分隔) */
export const parseTokens = (value: string): string[] =>
  value
    .split(/[\n,]/)
    .map((x) => x.trim())
    .filter(Boolean);

/** 要查库的写法;普通域名、网段不用查 */
export const isGeoToken = (token: string): boolean => /^!*(geosite:|geoip:|ext(-domain|-site|-ip)?:)/i.test(token.trim());

export function tokenFor(file: string, code: string, kind: GeoKind): string {
  if (kind === 'ip' && file === 'geoip.dat') return `geoip:${code}`;
  if (kind === 'site' && file === 'geosite.dat') return `geosite:${code}`;
  return `ext:${file}:${code}`;
}

export function canonicalToken(token: string): string {
  const lowered = token.trim().toLowerCase();
  for (const [pattern, short] of LONG_FORMS) if (pattern.test(lowered)) return lowered.replace(pattern, short);
  return lowered;
}

/** 框里已经有的、属于 known(浏览过的库里的分类)的写法:打开浏览器时预先勾上 */
export function selectionFromValue(value: string, known: ReadonlySet<string>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const token of parseTokens(value)) {
    const c = canonicalToken(token);
    if (!known.has(c) || seen.has(c)) continue;
    seen.add(c);
    out.push(token);
  }
  return out;
}

/**
 * 「应用」后框里的内容:原来的项照旧保留(普通域名、没浏览过的库里的分类),
 * 浏览过的库里被取消勾选的去掉,新勾上的接在后面;重复的只留一个
 */
export function mergeSelection(value: string, selected: string[], known: ReadonlySet<string>, separator: string): string {
  const kept = new Set(selected.map(canonicalToken).filter(Boolean));
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (token: string) => {
    const c = canonicalToken(token);
    if (!c || seen.has(c)) return;
    seen.add(c);
    out.push(token.trim());
  };
  for (const token of parseTokens(value)) {
    const c = canonicalToken(token);
    if (known.has(c) && !kept.has(c)) continue;
    add(token);
  }
  for (const token of selected) add(token);
  return out.join(separator);
}
