// 出口规则编辑时的一行(表单用的字符串形式),和保存用的 LineRule 互转。单条线路和批量改共用。

import type { LineRule } from './types';

export interface RuleRow {
  domain: string;
  ip: string;
  port: string;
  network: string;
  /** 'direct' / 'block' / 'socks:<id>' */
  to: string;
}

export const toRow = (r: LineRule): RuleRow => ({ domain: r.domain.join('\n'), ip: r.ip.join(', '), port: r.port, network: r.network, to: r.to.kind === 'socks' ? `socks:${r.to.socks_id}` : r.to.kind });

export const fromRow = (r: RuleRow): LineRule => ({
  domain: r.domain.split(/[\n,]/).map((x) => x.trim()).filter(Boolean),
  ip: r.ip.split(/[\n,]/).map((x) => x.trim()).filter(Boolean),
  port: r.port.trim(),
  network: r.network,
  to: r.to.startsWith('socks:') ? { kind: 'socks', socks_id: Number(r.to.slice(6)) } : r.to === 'block' ? { kind: 'block' } : { kind: 'direct' },
});
