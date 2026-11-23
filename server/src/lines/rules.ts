// 线路的出口规则:在 xui-hub 里给某条线路(某个入站上的某个客户端)配「条件 → 出口」,写进这块面板的 Xray 路由。
// 没命中这些规则的流量照旧走线路原来的出口(直出或开线路时选的 SOCKS)。
// - 条件:域名(含 geosite:xxx、domain:、full:、keyword:、regexp:)、IP(含 geoip:xxx、CIDR)、端口、网络(tcp / udp),至少填一样;
// - 出口:SOCKS 页登记的代理、直出、拦截。
// 写到面板上的规则带 ruleTag「xui-hub:入站:客户端:序号」,本系统只改带这个标记的;面板上手配的规则不碰。

import type { DB } from '../db';
import { InputError } from '../panels/repo';
import { getSocks } from '../socks/repo';

export const MAX_RULES = 20;
const MAX_ITEMS = 200;
const MAX_ITEM_LEN = 200;

export type RuleTarget = { kind: 'socks'; socks_id: number } | { kind: 'direct' } | { kind: 'block' };

export interface LineRule {
  domain: string[];
  ip: string[];
  /** 如 443、1000-2000、80,443;空 = 不限 */
  port: string;
  /** tcp / udp / tcp,udp;空 = 不限 */
  network: string;
  to: RuleTarget;
}

/** 数组或按逗号 / 换行分隔的字符串 → 去重的列表 */
function items(raw: unknown, label: string): string[] {
  const list = (Array.isArray(raw) ? raw : String(raw ?? '').split(/[\n,]/)).map((x) => String(x ?? '').trim()).filter(Boolean);
  const out = [...new Set(list)];
  if (out.length > MAX_ITEMS) throw new InputError(`${label}最多 ${MAX_ITEMS} 项`);
  for (const x of out) {
    if (x.length > MAX_ITEM_LEN) throw new InputError(`${label}里的「${x.slice(0, 30)}…」太长`);
    if (/\s/.test(x)) throw new InputError(`${label}里的「${x}」不能有空格`);
  }
  return out;
}

const IP_ITEM = /^(geoip:!?[a-z0-9-]+|ext:[^:]+:[^:]+|[0-9a-f.:]+(\/\d{1,3})?)$/i;

function validTarget(db: DB, raw: any): RuleTarget {
  const kind = raw?.kind;
  if (kind === 'direct' || kind === 'block') return { kind };
  if (kind === 'socks') {
    const id = Number(raw?.socks_id);
    if (!Number.isInteger(id) || !getSocks(db, id)) throw new InputError('规则的出口要选 SOCKS 页登记的代理');
    return { kind, socks_id: id };
  }
  throw new InputError('规则的出口只能是 SOCKS、直出或拦截');
}

export function validRules(db: DB, raw: unknown): LineRule[] {
  if (!Array.isArray(raw)) throw new InputError('rules 要是数组');
  if (raw.length > MAX_RULES) throw new InputError(`每条线路最多 ${MAX_RULES} 条规则`);
  return raw.map((r: any, i) => {
    const at = `第 ${i + 1} 条规则`;
    const domain = items(r?.domain, `${at}的域名`);
    const ip = items(r?.ip, `${at}的 IP`);
    const bad = ip.find((x) => !IP_ITEM.test(x));
    if (bad) throw new InputError(`${at}的 IP「${bad}」不对:写 IP、网段(如 203.0.113.0/24)或 geoip:国家代码`);
    const port = String(r?.port ?? '').replace(/\s+/g, '');
    if (port && !/^\d{1,5}(-\d{1,5})?(,\d{1,5}(-\d{1,5})?)*$/.test(port)) throw new InputError(`${at}的端口写法不对,如 443、1000-2000、80,443`);
    const network = String(r?.network ?? '').replace(/\s+/g, '').toLowerCase();
    if (network && !['tcp', 'udp', 'tcp,udp', 'udp,tcp'].includes(network)) throw new InputError(`${at}的网络只能是 tcp、udp 或 tcp,udp`);
    if (!domain.length && !ip.length && !port && !network) throw new InputError(`${at}至少要填域名、IP、端口、网络中的一样`);
    return { domain, ip, port, network, to: validTarget(db, r?.to) };
  });
}

