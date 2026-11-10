// 统一订阅:汇总客户各线路的节点链接。链接每次都从面板 /clients/links 现取,不缓存也不兜底:
// 线路换了入站下次拉订阅就是新链接;面板取不到时这条线路不出节点(error 里写原因)。

import type { DB } from '../db';
import { XUIClient } from '../xui/client';

export interface LineLinks {
  panel_id: number;
  panel_name: string;
  email: string;
  links: string[];
  error?: string;
}

export type LinkFetcher = (panel: { name: string; base_url: string; token: string }, email: string) => Promise<string[]>;

export function defaultFetcher(opts: { timeoutMs: number }): LinkFetcher {
  return async (panel, email) => {
    const client = new XUIClient(panel, { timeoutMs: opts.timeoutMs });
    try {
      return await client.clientLinks(email);
    } finally {
      await client.close().catch(() => {});
    }
  };
}

export async function collectLinks(db: DB, customerId: number, fetcher: LinkFetcher): Promise<LineLinks[]> {
  const lines = db
    .prepare(
      `SELECT l.panel_id, l.email, p.name AS panel_name, p.base_url, p.token
       FROM lines l
       JOIN panels p ON p.id = l.panel_id
       WHERE l.customer_id = ?
       ORDER BY l.id`,
    )
    .all(customerId) as any[];

  return Promise.all(
    lines.map(async (row): Promise<LineLinks> => {
      const base = { panel_id: row.panel_id, panel_name: row.panel_name, email: row.email };
      try {
        const panel = { name: row.panel_name, base_url: row.base_url, token: row.token };
        const links = (await fetcher(panel, row.email)).filter((l) => typeof l === 'string' && l.includes('://'));
        return { ...base, links };
      } catch (e: any) {
        return { ...base, links: [], error: e?.message ?? String(e) };
      }
    }),
  );
}

/** 去重后按线路顺序合并 */
export function mergeLinks(lines: LineLinks[]): string[] {
  return [...new Set(lines.flatMap((l) => l.links))];
}

/** base64 订阅:每行一个,CRLF 换行且末尾带换行(与主流面板一致);没有节点时为空 */
export function encodeSubscription(links: string[]): string {
  return links.length ? Buffer.from(links.join('\r\n') + '\r\n', 'utf8').toString('base64') : '';
}

/** 与 3x-ui 一致:total/expire 为 0 表示不限 */
export function userinfoHeader(c: { used_up: number; used_down: number; quota_bytes: number; expire_at: number }): string {
  return `upload=${c.used_up}; download=${c.used_down}; total=${c.quota_bytes}; expire=${Math.floor(c.expire_at / 1000)}`;
}
