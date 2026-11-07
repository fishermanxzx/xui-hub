// 调用内部 subconverter 把节点转换成 Clash / Surge 等格式。

import type { Target } from './format';

export interface Converted {
  body: string;
}

const NODE_LIST_TARGETS = new Set(['quanx', 'loon', 'surge']);

export type Converter = (target: Exclude<Target, 'base64'> | 'mixed', sourceUrl: string, options: Record<string, string>) => Promise<Converted>;

export function subconverterClient(baseUrl: string, timeoutMs = 30_000): Converter {
  return async (target, sourceUrl, options) => {
    // 转换参数原样透传,target/url 以本次请求为准
    const params = new URLSearchParams({ ...options, target, url: sourceUrl });
    if (target === 'surge' && !params.has('ver')) params.set('ver', '4');
    // Quantumult X / Loon / Surge 的订阅一般作为节点资源导入:只给节点列表,不给整份配置
    if (NODE_LIST_TARGETS.has(target)) params.set('list', 'true');
    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/sub?${params}`, { signal: AbortSignal.timeout(timeoutMs) });
    const body = await res.text();
    if (!res.ok) throw new Error(`subconverter ${res.status}:${body.slice(0, 200)}`);
    return { body };
  };
}
