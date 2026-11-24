// 自己记的收入 / 支出,不挂客户:买服务器、域名、SOCKS 这类支出,和客户续费以外的收入。
// 客户的续费 / 收款在 customers/payments.ts;账本页把两边合在一起算收入、支出、净收入。
// 记错了删掉重记;删一笔只删记录,不动别的。

import type { DB } from '../db';
import { InputError } from '../panels/repo';
import { validNote } from '../customers/payments';

export type EntryKind = 'income' | 'expense';

export interface LedgerEntry {
  id: number;
  kind: EntryKind;
  /** 金额,总是正数(支出也记正数,按 kind 算进收入或支出) */
  amount: number;
  /** 日期(毫秒) */
  at: number;
  /** 类别,如「服务器」「域名」;可以空 */
  category: string;
  note: string;
  created_at: number;
}

export type EntryInsert = Omit<LedgerEntry, 'id' | 'created_at'>;

const CATEGORY_MAX = 20;

/** 校验请求体:kind、amount 必填;at 不给 = 现在;category、note 可以空 */
export function validEntry(body: Record<string, unknown>, now = Date.now()): EntryInsert {
  if (body.kind !== 'income' && body.kind !== 'expense') throw new InputError('kind 要是 income(收入)或 expense(支出)');
  const n = body.amount == null || body.amount === '' ? NaN : Number(body.amount);
  const amount = Math.round(n * 100) / 100;
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1e8) throw new InputError('金额要是大于 0 的数字(支出也填正数),不超过 1 亿');
  let at = now;
  if (body.at != null && body.at !== '') {
    at = Number(body.at);
    if (!Number.isSafeInteger(at) || at <= 0) throw new InputError('日期要是毫秒时间戳');
  }
  if (body.category != null && typeof body.category !== 'string') throw new InputError('类别要是文字');
  const category = (body.category ?? '').trim();
  if (category.length > CATEGORY_MAX) throw new InputError(`类别最多 ${CATEGORY_MAX} 个字`);
  return { kind: body.kind, amount, at, category, note: validNote(body.note) };
}

export function insertEntry(db: DB, e: EntryInsert, now = Date.now()): LedgerEntry {
  const id = db.prepare('INSERT INTO ledger_entries (kind, amount, at, category, note, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(e.kind, e.amount, e.at, e.category, e.note, now).lastInsertRowid;
  return getEntry(db, Number(id))!;
}

export function getEntry(db: DB, id: number): LedgerEntry | undefined {
  return db.prepare('SELECT * FROM ledger_entries WHERE id = ?').get(id) as LedgerEntry | undefined;
}

/** 新的在前。from / to:日期在 [from, to) 里的 */
export function listEntries(db: DB, opts: { from?: number; to?: number } = {}): LedgerEntry[] {
  const where: string[] = [];
  if (opts.from != null) where.push('at >= @from');
  if (opts.to != null) where.push('at < @to');
  const sql = `SELECT * FROM ledger_entries${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY at DESC, id DESC`;
  return db.prepare(sql).all({ from: opts.from ?? null, to: opts.to ?? null }) as LedgerEntry[];
}

export function deleteEntry(db: DB, id: number): void {
  if (!db.prepare('DELETE FROM ledger_entries WHERE id = ?').run(id).changes) throw new InputError('这笔记录不存在');
}
