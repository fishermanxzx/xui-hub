// 续费和收款记录。续费(POST /customers/:id/renew)每次记一笔,填了金额就是一笔收款;也可以单独记收款(不续期)。
// 记录只用来记账,删掉一笔不会改回到期日。客户删了记录还在,显示记的时候的名字。

import type { DB } from '../db';
import { InputError } from '../panels/repo';

export interface Payment {
  id: number;
  customer_id: number;
  /** 客户现在的名字;客户删了是记的时候的名字 */
  customer_name: string;
  /** 客户已经删了 */
  customer_deleted: boolean;
  /** 收了多少(负数 = 退款);null = 只续期,没记钱 */
  amount: number | null;
  /** 收款日期(毫秒) */
  paid_at: number;
  /** 这笔续了几个月 / 几天;都是 0 = 只记收款 */
  months: number;
  days: number;
  /** 这笔前后的到期时间(毫秒,0 = 不限期) */
  expire_before: number;
  expire_after: number;
  note: string;
  created_at: number;
}

export interface PaymentInsert {
  customer_id: number;
  customer_name: string;
  amount: number | null;
  paid_at: number;
  months?: number;
  days?: number;
  expire_before: number;
  expire_after: number;
  note: string;
}

const DAY_MS = 86_400_000;

/** 金额:空 = 不记钱(null);可以是负数(退款),两位小数 */
export function validAmount(value: unknown): number | null {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || Math.abs(n) > 1e8) throw new InputError('金额要是数字(负数 = 退款),绝对值不超过 1 亿;留空 = 不记钱');
  return Math.round(n * 100) / 100;
}

/** 收款日期(毫秒):空 = 现在 */
export function validPaidAt(value: unknown, now = Date.now()): number {
  if (value == null || value === '') return now;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) throw new InputError('收款日期要是毫秒时间戳');
  return n;
}

export function validNote(value: unknown): string {
  if (value == null) return '';
  if (typeof value !== 'string') throw new InputError('备注要是文字');
  const note = value.trim();
  if (note.length > 200) throw new InputError('备注最多 200 个字');
  return note;
}

/** 续多久:months(1-120)和 days(1-3650)给一个(另一个不给或给 0) */
export function renewSpan(body: { months?: unknown; days?: unknown }): { months: number; days: number } {
  const has = (v: unknown) => v != null && v !== '' && v !== 0 && v !== '0';
  if (has(body.months) === has(body.days)) throw new InputError('months(按月续)和 days(按天续)要给一个');
  if (has(body.months)) {
    const months = Number(body.months);
    if (!Number.isInteger(months) || months < 1 || months > 120) throw new InputError('months 要是 1 到 120 的整数');
    return { months, days: 0 };
  }
  const days = Number(body.days);
  if (!Number.isInteger(days) || days < 1 || days > 3650) throw new InputError('days 要是 1 到 3650 的整数');
  return { months: 0, days };
}

/** 加 n 个自然月,日子不变;那个月没有这一天就取月底(1-31 加一个月是 2-28 / 29)。按服务器时区 */
export function addMonths(ms: number, n: number): number {
  const d = new Date(ms);
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + n);
  d.setDate(Math.min(day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()));
  return d.getTime();
}

/** 续之后的到期时间:在现在的到期日上加(已到期或不限期的从现在起算) */
export function renewedExpire(expireAt: number, span: { months: number; days: number }, now = Date.now()): number {
  const base = Math.max(expireAt, now);
  return span.months ? addMonths(base, span.months) : base + span.days * DAY_MS;
}

interface Row extends Omit<Payment, 'customer_deleted'> {
  current_name: string | null;
}

const SELECT = 'SELECT p.*, c.name AS current_name FROM payments p LEFT JOIN customers c ON c.id = p.customer_id';
const toPayment = ({ current_name, ...r }: Row): Payment => ({ ...r, customer_name: current_name ?? r.customer_name, customer_deleted: current_name == null });

export function insertPayment(db: DB, p: PaymentInsert, now = Date.now()): Payment {
  const id = db
    .prepare('INSERT INTO payments (customer_id, customer_name, amount, paid_at, months, days, expire_before, expire_after, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(p.customer_id, p.customer_name, p.amount, p.paid_at, p.months ?? 0, p.days ?? 0, p.expire_before, p.expire_after, p.note, now).lastInsertRowid;
  return getPayment(db, Number(id))!;
}

export function getPayment(db: DB, id: number): Payment | undefined {
  const row = db.prepare(`${SELECT} WHERE p.id = ?`).get(id) as Row | undefined;
  return row && toPayment(row);
}

/** 新的在前。customer_id:只要这位客户的;from / to:收款日期在 [from, to) 里的 */
export function listPayments(db: DB, opts: { customer_id?: number; from?: number; to?: number } = {}): Payment[] {
  const where: string[] = [];
  if (opts.customer_id != null) where.push('p.customer_id = @customer_id');
  if (opts.from != null) where.push('p.paid_at >= @from');
  if (opts.to != null) where.push('p.paid_at < @to');
  const sql = `${SELECT}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY p.paid_at DESC, p.id DESC`;
  return (db.prepare(sql).all({ customer_id: opts.customer_id ?? null, from: opts.from ?? null, to: opts.to ?? null }) as Row[]).map(toPayment);
}

export function deletePayment(db: DB, id: number): void {
  if (!db.prepare('DELETE FROM payments WHERE id = ?').run(id).changes) throw new InputError('这笔记录不存在');
}

/** 每位客户最近一笔收款(金额大于 0 的;只续期没记钱的、退款不算) */
export function lastPayments(db: DB): Map<number, { amount: number; paid_at: number }> {
  const rows = db
    .prepare(
      `SELECT customer_id, amount, paid_at FROM (
         SELECT customer_id, amount, paid_at, ROW_NUMBER() OVER (PARTITION BY customer_id ORDER BY paid_at DESC, id DESC) AS n
         FROM payments WHERE amount > 0
       ) WHERE n = 1`,
    )
    .all() as { customer_id: number; amount: number; paid_at: number }[];
  return new Map(rows.map((r) => [r.customer_id, { amount: r.amount, paid_at: r.paid_at }]));
}
