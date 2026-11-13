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
