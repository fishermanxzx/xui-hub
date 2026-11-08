// 订阅格式:按客户端 User-Agent 自动选择,也可用 ?target= 指定。

export type Target = 'base64' | 'clash' | 'singbox' | 'surge' | 'quanx' | 'loon';

const UA_RULES: [RegExp, Target][] = [
  // Hiddify 基于 sing-box;它的 UA 同时含 ClashMeta,需排在 clash 之前
  [/hiddify/i, 'singbox'],
  // Clash Verge / Mihomo Party / FlClash / ClashMeta for Android / Stash / NekoBox(Prefer ClashMeta)
  [/clash|mihomo|stash|nyanpasu/i, 'clash'],
  // sing-box 官方客户端:SFA/SFI/SFM/SFT 或 UA 含 sing-box
  [/sing-?box|^SF[AIMT]\//i, 'singbox'],
  [/surge/i, 'surge'],
  [/quantumult/i, 'quanx'],
  [/loon/i, 'loon'],
  // Shadowrocket 解析面板生成的部分节点链接会失败(2026-11-01 实测 base64 各种写法都报"服务器 URL 遇到问题"),
  // 给 Clash 配置 + subscription-userinfo 头
  [/shadowrocket/i, 'clash'],
  // 直接吃节点链接的通用客户端
  [/v2ray|nekobox|nekoray|v2box|streisand|foxray|happ\//i, 'base64'],
];

export function isStashUA(ua: string | undefined): boolean {
  return !!ua && /stash/i.test(ua);
}

/** 识别不出(浏览器、脚本等)返回 null,由调用方决定默认格式 */
export function targetFromUA(ua: string | undefined): Target | null {
  if (!ua) return null;
  for (const [pattern, target] of UA_RULES) if (pattern.test(ua)) return target;
  return null;
}

/** 浏览器:UA 带 Mozilla/ 且不是任何已知代理客户端 */
export function isBrowserUA(ua: string | undefined): boolean {
  return !!ua && /mozilla\//i.test(ua) && targetFromUA(ua) == null;
}

const PARAM_ALIASES: Record<string, Target> = {
  base64: 'base64',
  v2ray: 'base64',
  mixed: 'base64',
  clash: 'clash',
  clashmeta: 'clash',
  mihomo: 'clash',
  singbox: 'singbox',
  'sing-box': 'singbox',
  surge: 'surge',
  quanx: 'quanx',
  loon: 'loon',
};

export function targetFromParam(value: unknown): Target | null {
  return typeof value === 'string' ? (PARAM_ALIASES[value.toLowerCase()] ?? null) : null;
}

/** 经 subconverter 转换 Clash / Surge 时的参数;规则用 ACL4SSR Online Mini */
export const DEFAULT_CONVERT_OPTIONS: Record<string, string> = {
  insert: 'false',
  config: 'https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/config/ACL4SSR_Online_Mini.ini',
  emoji: 'true',
  list: 'false',
  tfo: 'false',
  scv: 'true',
  fdn: 'false',
  expand: 'true',
  sort: 'false',
  new_name: 'true',
};
