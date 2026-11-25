// 面板 / SOCKS 续费:到期日往后顺延(按月或按天,和客户续费同一个算法:在到期日上加,已过期 / 没填到期日的从现在起算),
// 填了金额就顺手在账本里记一笔关联它的支出。两件事一起成或一起不成。

import { renewedExpire, renewSpan, validPaidAt } from '../customers/payments';
import type { DB } from '../db';
import { InputError } from '../panels/repo';
import { insertEntry, validEntry, type LedgerEntry } from './entries';

export type AssetKind = 'panel' | 'socks';

export interface AssetRenewal {
  kind: AssetKind;
  id: number;
  name: string;
  months: number;
  days: number;
  /** 续之前 / 之后的到期(毫秒,0 = 之前没填) */
  expire_before: number;
  expire_after: number;
  /** 记下的那笔支出;没填金额 = null */
  entry: LedgerEntry | null;
}

const TABLE: Record<AssetKind, string> = { panel: 'panels', socks: 'socks_proxies' };

/**
 * body:months / days 给一个;amount 金额(空 = 不记钱,填了要大于 0);paid_at 付款日期(毫秒,空 = 现在);
 * category 类别(如「服务器」,可空);note 备注
 */
export function renewAsset(db: DB, kind: AssetKind, id: number, body: Record<string, unknown>, now = Date.now()): AssetRenewal {
  const row = db.prepare(`SELECT id, name, expire_at FROM ${TABLE[kind]} WHERE id = ?`).get(id) as { id: number; name: string; expire_at: number } | undefined;
  if (!row) throw new InputError(kind === 'panel' ? '面板不存在' : 'SOCKS 不存在');
  const span = renewSpan(body);
  const paid = body.amount != null && body.amount !== '';
  // 金额、类别、备注按记一笔支出的规则校验(先校验,再改到期日)
  const entry = paid
    ? validEntry({ kind: 'expense', amount: body.amount, at: validPaidAt(body.paid_at, now), category: body.category, note: body.note, [`${kind}_id`]: id }, now)
    : null;
  const after = renewedExpire(row.expire_at, span, now);
  return db.transaction(() => {
    db.prepare(`UPDATE ${TABLE[kind]} SET expire_at = ?${kind === 'socks' ? ', updated_at = ?' : ''} WHERE id = ?`).run(...(kind === 'socks' ? [after, now, id] : [after, id]));
    return { kind, id, name: row.name, ...span, expire_before: row.expire_at, expire_after: after, entry: entry && insertEntry(db, entry, now) };
  })();
}
