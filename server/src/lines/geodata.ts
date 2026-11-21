// 出口规则里的 geo 写法(geosite:xxx、geoip:xxx、ext:文件:分类)按线路所在面板自己的 geo 库核对。
// 库在面板的 Xray 目录里,各面板可能不一样(有的多装了 geosite_IR.dat 之类),所以每次都问那块面板(3x-ui 3.7.0 起有这个接口)。
// 分类名写错、库不存在、写法不对、geoip 填进域名里:Xray 带着这样的规则起不来,面板上所有客户端都断,保存前就拦下。
// 属性不存在(geosite:cn@xxx):Xray 能起来,只是这条匹配不到东西,只在界面上提醒,不拦。

import { InputError } from '../panels/repo';
import type { GeoIssue, GeoKind } from '../xui/client';
import { XUIError } from '../xui/client';
import type { LineRule } from './rules';

export interface GeoValidator {
  /** 3x-ui 3.7.0 以前的面板没有这个接口(404) */
  geodataValidate?(kind: GeoKind, tokens: string[]): Promise<GeoIssue[]>;
}

/** 面板一次最多核对这么多个 */
const BATCH = 500;

/** 要查库的写法:geosite: / geoip: / ext:…(含 ! 开头的反选);普通域名、网段不用查 */
export const isGeoToken = (token: string) => /^!*(geosite:|geoip:|ext(-domain|-site|-ip)?:)/i.test(token.trim());

/** Xray 带着它起不来的原因(属性不存在不算) */
export const FATAL_REASONS = new Set(['syntax', 'fileMissing', 'categoryMissing', 'wrongKind']);

/** 面板没有 geo 接口(3x-ui 3.7.0 以前) */
export const isGeoUnsupported = (e: unknown) => e instanceof XUIError && e.status === 404;

/** 按面板的库核对一组写法;面板不支持核对时返回 null */
export async function validateTokens(admin: GeoValidator, kind: GeoKind, tokens: string[]): Promise<GeoIssue[] | null> {
  if (!admin.geodataValidate) return null;
  const list = [...new Set(tokens.map((x) => x.trim()).filter(isGeoToken))];
  const issues: GeoIssue[] = [];
  try {
    for (let i = 0; i < list.length; i += BATCH) issues.push(...(await admin.geodataValidate(kind, list.slice(i, i + BATCH))));
  } catch (e) {
    if (isGeoUnsupported(e)) return null;
    throw e;
  }
  return issues;
}

function reasonText(issue: GeoIssue, kind: GeoKind): string {
  switch (issue.reason) {
    case 'categoryMissing':
      return `面板的 ${issue.file || (kind === 'ip' ? 'geoip.dat' : 'geosite.dat')} 里没有「${issue.code ?? ''}」这个分类`;
    case 'fileMissing':
      return `面板上没有 ${issue.file ?? ''} 这个库`;
    case 'wrongKind':
      return kind === 'ip' ? 'geosite 是域名库,要填在域名里' : 'geoip 是 IP 库,要填在 IP 里';
    default:
      return 'Xray 不认这种写法';
  }
}

/**
 * 写规则之前按这块面板的 geo 库核对:有会让 Xray 起不来的写法就报错(说清是第几条规则、哪个写法、为什么)。
 * 面板太老没有核对接口时不查,照旧写
 */
export async function checkRulesGeo(admin: GeoValidator, rules: LineRule[]): Promise<void> {
  const problems: string[] = [];
  for (const [field, kind, label] of [['domain', 'site', '域名'], ['ip', 'ip', 'IP']] as const) {
    const tokens = rules.flatMap((r) => r[field]);
    if (!tokens.some(isGeoToken)) continue;
    const issues = await validateTokens(admin, kind, tokens);
    if (!issues) return;
    for (const issue of issues.filter((x) => FATAL_REASONS.has(x.reason))) {
      const at = rules.findIndex((r) => r[field].some((x) => x.trim() === issue.token));
      problems.push(`${at >= 0 ? `第 ${at + 1} 条规则的` : ''}${label}「${issue.token}」:${reasonText(issue, kind)}`);
    }
  }
  if (problems.length) throw new InputError(`${problems.slice(0, 5).join(';')}${problems.length > 5 ? ` 等 ${problems.length} 处` : ''}。改好再存,不然这块面板的 Xray 起不来`);
}
