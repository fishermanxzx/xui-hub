// 账本里的一笔:客户的续费 / 收款(Payment),或自己记的收入 / 支出(LedgerEntry,带 kind)。
import type { LedgerEntry, Payment } from './types';

export type LedgerRow = Payment | LedgerEntry;

export const isEntry = (r: LedgerRow): r is LedgerEntry => 'kind' in r;
/** 行的 key:两张表的 id 会重,带上前缀 */
export const rowKey = (r: LedgerRow) => (isEntry(r) ? `e${r.id}` : `p${r.id}`);
export const rowAt = (r: LedgerRow) => (isEntry(r) ? r.at : r.paid_at);
/** 这一笔算多少钱(按分):收款 / 其它收入是正的,退款和支出是负的,只续期没记钱的是 0 */
export const rowCents = (r: LedgerRow) => Math.round((isEntry(r) ? (r.kind === 'expense' ? -r.amount : r.amount) : (r.amount ?? 0)) * 100);
