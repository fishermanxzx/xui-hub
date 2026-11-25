// 自己记的收入 / 支出:买服务器、域名、SOCKS 这类支出,和续费以外的收入。
// 可以关联一块面板或一个 SOCKS(二选一,收入、支出都行),收入还可以关联一位客户;都不是必选。
// 关联的东西删了记录还在,显示记的时候的名字。
// 客户的续费 / 收款在 customers/payments.ts;账本页把两边合在一起算收入、支出、净收入。
// 记错了可以改(PATCH,只给要改的字段)或删掉;改 / 删都只动这笔记录,不动别的。

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
  /** 关联的客户(只有收入能关联);null = 没关联 */
  customer_id: number | null;
  /** 客户现在的名字;客户删了是记的时候的名字;没关联是空 */
  customer_name: string;
  customer_deleted: boolean;
  /** 关联的面板 / SOCKS,最多一个;null = 没关联。名字、删没删同客户 */
  panel_id: number | null;
  panel_name: string;
  panel_deleted: boolean;
  socks_id: number | null;
  socks_name: string;
  socks_deleted: boolean;
  created_at: number;
}

export interface EntryInsert {
  kind: EntryKind;
  amount: number;
  at: number;
  category: string;
  note: string;
  customer_id?: number | null;
  panel_id?: number | null;
  socks_id?: number | null;
}

const CATEGORY_MAX = 20;

/** 关联的 id:不给 / 空 / null = 不关联 */
function linkId(value: unknown, what: string): number | null {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) throw new InputError(`${what}要是 id(正整数)`);
  return n;
}

/** 校验请求体:kind、amount 必填;at 不给 = 现在;category、note 可以空;customer_id / panel_id / socks_id 可以不给 */
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
  const customer_id = linkId(body.customer_id, 'customer_id');
  const panel_id = linkId(body.panel_id, 'panel_id');
  const socks_id = linkId(body.socks_id, 'socks_id');
  if (customer_id != null && body.kind !== 'income') throw new InputError('只有收入能关联客户');
  if (panel_id != null && socks_id != null) throw new InputError('面板和 SOCKS 只能关联一个');
  return { kind: body.kind, amount, at, category, note: validNote(body.note), customer_id, panel_id, socks_id };
}

/**
 * 关联的东西的名字(记下来,之后删了还显示它):要存在;keep = 这笔原来就关联它,删了也照样留着原来记的名字
 */
function linkName(db: DB, table: string, id: number | null | undefined, missing: string, keep?: { id: number | null; name: string }): string {
  if (id == null) return '';
  const row = db.prepare(`SELECT name FROM ${table} WHERE id = ?`).get(id) as { name: string } | undefined;
  if (row) return row.name;
  if (keep && keep.id === id) return keep.name;
  throw new InputError(missing);
}

/** 记一笔;关联的客户 / 面板 / SOCKS 要存在,名字记下来(之后删了还显示它) */
export function insertEntry(db: DB, e: EntryInsert, now = Date.now()): LedgerEntry {
  const customer_name = linkName(db, 'customers', e.customer_id, '客户不存在');
  const panel_name = linkName(db, 'panels', e.panel_id, '面板不存在');
  const socks_name = linkName(db, 'socks_proxies', e.socks_id, 'SOCKS 不存在');
  const id = db
    .prepare(
      `INSERT INTO ledger_entries (kind, amount, at, category, note, customer_id, customer_name, panel_id, panel_name, socks_id, socks_name, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(e.kind, e.amount, e.at, e.category, e.note, e.customer_id ?? null, customer_name, e.panel_id ?? null, panel_name, e.socks_id ?? null, socks_name, now).lastInsertRowid;
  return getEntry(db, Number(id))!;
}

interface Row extends Omit<LedgerEntry, 'customer_deleted' | 'panel_deleted' | 'socks_deleted'> {
  cur_customer: string | null;
  cur_panel: string | null;
  cur_socks: string | null;
}

const SELECT = `SELECT e.*, c.name AS cur_customer, p.name AS cur_panel, s.name AS cur_socks FROM ledger_entries e
  LEFT JOIN customers c ON c.id = e.customer_id
  LEFT JOIN panels p ON p.id = e.panel_id
  LEFT JOIN socks_proxies s ON s.id = e.socks_id`;

/** 关联了的显示现在的名字;删了显示记的时候的名字,标上删了 */
const toEntry = ({ cur_customer, cur_panel, cur_socks, ...r }: Row): LedgerEntry => ({
  ...r,
  customer_name: cur_customer ?? r.customer_name,
  customer_deleted: r.customer_id != null && cur_customer == null,
  panel_name: cur_panel ?? r.panel_name,
  panel_deleted: r.panel_id != null && cur_panel == null,
  socks_name: cur_socks ?? r.socks_name,
  socks_deleted: r.socks_id != null && cur_socks == null,
});

export function getEntry(db: DB, id: number): LedgerEntry | undefined {
  const row = db.prepare(`${SELECT} WHERE e.id = ?`).get(id) as Row | undefined;
  return row && toEntry(row);
}

/** 新的在前。from / to:日期在 [from, to) 里的;customer_id:只要关联了这位客户的 */
export function listEntries(db: DB, opts: { from?: number; to?: number; customer_id?: number } = {}): LedgerEntry[] {
  const where: string[] = [];
  if (opts.from != null) where.push('e.at >= @from');
  if (opts.to != null) where.push('e.at < @to');
  if (opts.customer_id != null) where.push('e.customer_id = @customer_id');
  const sql = `${SELECT}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY e.at DESC, e.id DESC`;
  return (db.prepare(sql).all({ from: opts.from ?? null, to: opts.to ?? null, customer_id: opts.customer_id ?? null }) as Row[]).map(toEntry);
}

/**
 * 改一笔:只给要改的字段,没给的照旧。规则和记一笔一样(validEntry)。顺带的:
 * - 改成支出又没说客户:关联的客户去掉(支出不能关联客户);
 * - 关联了面板又没说 SOCKS(或反过来):原来关联的另一个去掉(两个只能关联一个);
 * - 原来关联的东西删了、这次没改它:照样留着(显示原来记的名字)。
 */
export function updateEntry(db: DB, id: number, body: Record<string, unknown>, now = Date.now()): LedgerEntry {
  const cur = getEntry(db, id);
  if (!cur) throw new InputError('这笔记录不存在');
  const given = (k: string) => body[k] !== undefined;
  const set = (k: string) => given(k) && body[k] !== null && body[k] !== '';
  const merged: Record<string, unknown> = {
    kind: cur.kind,
    amount: cur.amount,
    category: cur.category,
    note: cur.note,
    customer_id: cur.customer_id,
    panel_id: cur.panel_id,
    socks_id: cur.socks_id,
    ...body,
    at: set('at') ? body.at : cur.at,
  };
  if (body.kind === 'expense' && !given('customer_id')) merged.customer_id = null;
  if (set('panel_id') && !given('socks_id')) merged.socks_id = null;
  if (set('socks_id') && !given('panel_id')) merged.panel_id = null;
  const e = validEntry(merged, now);
  const customer_name = linkName(db, 'customers', e.customer_id, '客户不存在', { id: cur.customer_id, name: cur.customer_name });
  const panel_name = linkName(db, 'panels', e.panel_id, '面板不存在', { id: cur.panel_id, name: cur.panel_name });
  const socks_name = linkName(db, 'socks_proxies', e.socks_id, 'SOCKS 不存在', { id: cur.socks_id, name: cur.socks_name });
  db.prepare(
    `UPDATE ledger_entries SET kind = ?, amount = ?, at = ?, category = ?, note = ?, customer_id = ?, customer_name = ?, panel_id = ?, panel_name = ?, socks_id = ?, socks_name = ? WHERE id = ?`,
  ).run(e.kind, e.amount, e.at, e.category, e.note, e.customer_id ?? null, customer_name, e.panel_id ?? null, panel_name, e.socks_id ?? null, socks_name, id);
  return getEntry(db, id)!;
}

export function deleteEntry(db: DB, id: number): void {
  if (!db.prepare('DELETE FROM ledger_entries WHERE id = ?').run(id).changes) throw new InputError('这笔记录不存在');
}
