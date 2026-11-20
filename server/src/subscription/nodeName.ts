// 线路的自定义节点名:填了就在订阅和分享链接里代替面板生成的名字(面板上的入站备注 / 客户端名都不改)。
// 名字在链接里的位置:vmess 是 base64 JSON 里的 ps,其余(vless / trojan / ss / hysteria2 …)是 # 后面那段。

import { InputError } from '../panels/repo';

const MAX_LEN = 64;

/** 空 = 不自定义(用面板生成的名字) */
export function validNodeName(value: unknown): string {
  const v = String(value ?? '').trim();
  if (v.length > MAX_LEN) throw new InputError(`节点名不能超过 ${MAX_LEN} 个字符`);
  if (/[\u0000-\u001f\u007f]/.test(v)) throw new InputError('节点名里不能有换行等控制字符');
  return v;
}

export function renameLink(link: string, name: string): string {
  if (/^vmess:\/\//i.test(link)) {
    try {
      const json = JSON.parse(Buffer.from(link.slice(8), 'base64').toString('utf8'));
      if (json && typeof json === 'object') return `vmess://${Buffer.from(JSON.stringify({ ...json, ps: name }), 'utf8').toString('base64')}`;
    } catch {
      // 不是 base64 JSON 的写法:按 # 处理
    }
  }
  const hash = link.indexOf('#');
  return `${hash < 0 ? link : link.slice(0, hash)}#${encodeURIComponent(name)}`;
}

/** 一条线路出了几个链接(面板配了多个地址)时,依次加上 2、3… 免得重名 */
export function renameLinks(links: string[], name: string): string[] {
  if (!name) return links;
  return links.map((l, i) => renameLink(l, i === 0 ? name : `${name} ${i + 1}`));
}
