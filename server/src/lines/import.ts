// 把面板上已有的客户端归到某位客户名下,成为他的一条直连线路。面板上什么都不改,只记一条线路并同步流量。
// 老用户接入面板时上面往往已经有一堆客户端,靠这个把它们管起来。

import { addLine, getCustomer, lineByEmail, updateLineStats, type Line } from '../customers/repo';
import type { DB } from '../db';
import { getPanel, InputError, type Panel } from '../panels/repo';
import { errorText, using } from '../util';
import { normalizeClients } from '../xui/normalize';
import { CLIENT_PROTOCOLS } from '../clients/create';

export interface ImportReader {
  listInbounds(): Promise<any[]>;
  listClients(): Promise<any[]>;
  close?(): Promise<void>;
}

export interface ImportInput {
  panel_id?: unknown;
  /** 一个或多个客户端的 email */
  emails?: unknown;
}

export interface ImportResult {
  lines: Line[];
  failed: { email: string; error: string }[];
}

export async function importClients(db: DB, customerId: number, input: ImportInput, readerFor: (panel: Panel) => ImportReader): Promise<ImportResult> {
  const customer = getCustomer(db, customerId);
  if (!customer) throw new InputError('客户不存在');
  const panel = getPanel(db, Number(input.panel_id));
  if (!panel) throw new InputError('面板不存在');
  const emails = [...new Set((Array.isArray(input.emails) ? input.emails : [input.emails]).map((e) => String(e ?? '').trim()).filter(Boolean))];
  if (!emails.length) throw new InputError('没有选客户端');

  return using(readerFor(panel), async (reader) => {
    const [inbounds, raw] = await Promise.all([reader.listInbounds(), reader.listClients()]);
    const clients = new Map(normalizeClients(raw, inbounds).map((c) => [c.email, c]));
    const inboundById = new Map(inbounds.map((ib) => [Number(ib.id), ib]));
    const result: ImportResult = { lines: [], failed: [] };
    for (const email of emails) {
      try {
        const owner = lineByEmail(db, panel.id, email);
        if (owner) {
          const name = (db.prepare('SELECT name FROM customers WHERE id = ?').get(owner.customer_id) as { name: string } | undefined)?.name ?? '?';
          throw new InputError(`已经是客户「${name}」的线路`);
        }
        const c = clients.get(email);
        if (!c) throw new InputError('面板上没有这个客户端');
        // 挂在多个入站上时取第一个能挂客户端的
        const ib = c.inboundIds.map((id) => inboundById.get(id)).find((x) => x && CLIENT_PROTOCOLS.has(String(x.protocol)));
        if (!ib) throw new InputError('这个客户端没挂在 vless / hy2 / trojan / vmess 入站上');
        const line = addLine(db, { customer_id: customer.id, kind: 'direct', panel_id: panel.id, inbound_id: Number(ib.id), inbound_remark: String(ib.remark ?? ''), protocol: String(ib.protocol ?? ''), email });
        updateLineStats(db, line.id, { up: c.up, down: c.down, enable: c.enable, last_online: c.lastOnline });
        result.lines.push({ ...line, up: c.up, down: c.down, enable: c.enable, last_online: c.lastOnline });
      } catch (e) {
        result.failed.push({ email, error: errorText(e) });
      }
    }
    return result;
  });
}
