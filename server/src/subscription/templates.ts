// Clash 订阅的分组 / 规则模板(subconverter 的 config 参数)。每位客户可以单独选一个,不选用默认的。
// 内置的都是 ACL4SSR 的在线模板;也可以填自己的模板地址(https,subconverter 的 ini 格式)。

import { InputError } from '../panels/repo';

const ACL = 'https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/config/';

export interface SubTemplate {
  id: string;
  name: string;
  desc: string;
  url: string;
}

export const DEFAULT_TEMPLATE = 'ACL4SSR_Online_Mini';

const t = (id: string, name: string, desc: string): SubTemplate => ({ id, name, desc, url: `${ACL}${id}.ini` });

export const TEMPLATES: SubTemplate[] = [
  t('ACL4SSR_Online_Mini', '精简(默认)', '节点选择、自动选择、直连、拦截、兜底,5 个分组'),
  t('ACL4SSR_Online_Mini_NoAuto', '精简 · 无自动测速', '同精简,去掉自动选择,只手动选节点'),
  t('ACL4SSR_Online_Mini_Fallback', '精简 · 故障转移', '同精简,多一个节点挂了自动切换的分组'),
  t('ACL4SSR_Online_Mini_MultiMode', '精简 · 多模式', '同精简,自动选择 / 故障转移 / 负载均衡都有'),
  t('ACL4SSR_Online_Mini_MultiCountry', '精简 · 按地区', '同精简,另按香港 / 日本 / 美国等地区分组'),
  t('ACL4SSR_Online', '标准', '多出电报、微软、苹果、国外媒体等分组,11 个'),
  t('ACL4SSR_Online_NoAuto', '标准 · 无自动测速', '同标准,去掉自动选择'),
  t('ACL4SSR_Online_MultiCountry', '标准 · 按地区', '同标准,另按地区分组'),
  t('ACL4SSR_Online_Full', '完整', '流媒体(奈飞、油管、哔哩哔哩等)、游戏、地区各自分组,约 30 个'),
  t('ACL4SSR_Online_Full_NoAuto', '完整 · 无自动测速', '同完整,去掉自动选择'),
  t('ACL4SSR_Online_Full_MultiMode', '完整 · 多模式', '同完整,自动选择 / 故障转移 / 负载均衡都有'),
];

const byId = new Map(TEMPLATES.map((x) => [x.id, x]));

/** 存库的值:'' = 默认;内置模板的 id;或自定义的 https 地址 */
export function validTemplate(value: unknown): string {
  const v = String(value ?? '').trim();
  if (!v || v === DEFAULT_TEMPLATE) return '';
  if (byId.has(v)) return v;
  if (v.length > 300) throw new InputError('模板地址太长');
  let url: URL;
  try {
    url = new URL(v);
  } catch {
    throw new InputError('订阅模板要么选内置的,要么填一个 https:// 开头的模板地址');
  }
  if (url.protocol !== 'https:') throw new InputError('自定义模板地址要以 https:// 开头');
  return url.toString();
}

/** 存库的值 → 给 subconverter 的模板地址 */
export function templateUrl(value: string | null | undefined): string {
  if (!value) return byId.get(DEFAULT_TEMPLATE)!.url;
  return byId.get(value)?.url ?? value;
}

export const isCustomTemplate = (value: string) => !!value && !byId.has(value);

export type TemplateFetcher = (url: string) => Promise<{ status: number; body: string }>;

/** 拉模板:最多等 8 秒、读 512 KB,不跟到别的协议上去 */
export const fetchTemplate: TemplateFetcher = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(8000), redirect: 'follow', headers: { 'User-Agent': 'xui-hub' } });
  return { status: res.status, body: (await res.text()).slice(0, 512_000) };
};

/**
 * 自定义模板地址保存前试拉一次:能取到、看着是 subconverter 的模板(有 custom_proxy_group= 或 ruleset= 行)才让存。
 * 不然填错了要等客户拉订阅时才报错。内网 / 本机地址不让填
 */
export async function checkCustomTemplate(url: string, fetcher: TemplateFetcher = fetchTemplate): Promise<void> {
  const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.)/.test(host) || host === '::1' || /^f[cde]/i.test(host) && host.includes(':')) {
    throw new InputError('模板地址不能是本机或内网地址');
  }
  let got: { status: number; body: string };
  try {
    got = await fetcher(url);
  } catch (e) {
    throw new InputError(`模板地址取不到:${e instanceof Error ? e.message : e}。确认这台服务器能访问它`);
  }
  if (got.status !== 200) throw new InputError(`模板地址返回 ${got.status},不是一份能用的模板`);
  if (!/^\s*(custom_proxy_group|ruleset)\s*=/m.test(got.body)) {
    throw new InputError('这个地址的内容不像 subconverter 的模板(里面没有 custom_proxy_group= 或 ruleset= 行)。要填 .ini 文件的原始地址,不是网页地址');
  }
}
