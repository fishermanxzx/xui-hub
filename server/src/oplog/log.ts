// 操作日志的存取:谁(后台 / API 令牌 / MCP)、什么时候、从哪个 IP、做了什么、成没成。保留一年。
// 记哪些、怎么写那句话见 describe.ts;在哪记见 http/routes.ts。

import type { DB } from '../db';

/** 保留的天数 */
export const OPLOG_KEEP_DAYS = 365;

export interface OpLog {
  id: number;
  at: number;
  /** 后台 / 令牌「名字」/ MCP · 客户端名 */
  actor: string;
  ip: string;
  /** 方法 + 路由,如 POST /customers/:id/renew */
  action: string;
  summary: string;
  ok: boolean;
  /** 没成的原因 */
  error: string;
  /** 涉及的客户(没有为 null) */
  customer_id: number | null;
}

export function addOpLog(db: DB, e: Omit<OpLog, 'id'>): void {
  db.prepare('INSERT INTO op_log (at, actor, ip, action, summary, ok, error, customer_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    e.at,
    e.actor,
    e.ip.slice(0, 64),
    e.action,
    e.summary.slice(0, 2000),
    e.ok ? 1 : 0,
    e.error.slice(0, 500),
    e.customer_id,
  );
}

/**
 * 新的在前。before:只要 id 比它小的(翻页);customer_id:只要涉及这位客户的;q:做了什么 / 谁 / IP 里含这段字的;
 * failed:只要没成的。多取一条判断还有没有更多。
 */
export function listOpLog(db: DB, opts: { before?: number; limit?: number; customer_id?: number; q?: string; failed?: boolean } = {}): { rows: OpLog[]; more: boolean } {
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 50) || 50, 1), 200);
  const where: string[] = [];
  if (opts.before) where.push('id < @before');
  if (opts.customer_id) where.push('customer_id = @customer_id');
  if (opts.failed) where.push('ok = 0');
  const q = opts.q?.trim();
  if (q) where.push(`(summary LIKE @q ESCAPE '\\' OR actor LIKE @q ESCAPE '\\' OR ip LIKE @q ESCAPE '\\')`);
  const rows = db
    .prepare(`SELECT * FROM op_log${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT @n`)
    .all({ before: opts.before ?? null, customer_id: opts.customer_id ?? null, q: q ? `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null, n: limit + 1 }) as (Omit<OpLog, 'ok'> & { ok: number })[];
  return { rows: rows.slice(0, limit).map((r) => ({ ...r, ok: r.ok === 1 })), more: rows.length > limit };
}

export function pruneOpLog(db: DB, now = Date.now()): void {
  db.prepare('DELETE FROM op_log WHERE at < ?').run(now - OPLOG_KEEP_DAYS * 86_400_000);
}

/** MCP 经内部通道调 /api 时,用这个头把「谁、从哪个 IP」带过去(内部通道之外进来的同名头不认) */
export const ACTOR_HEADER = 'x-xuihub-actor';

export function encodeActor(by: string, ip: string): string {
  return encodeURIComponent(JSON.stringify({ by, ip }));
}

export function decodeActor(value: string | undefined): { by: string; ip: string } | null {
  if (!value) return null;
  try {
    const v = JSON.parse(decodeURIComponent(value));
    return typeof v?.by === 'string' ? { by: v.by.slice(0, 100), ip: typeof v.ip === 'string' ? v.ip.slice(0, 64) : '' } : null;
  } catch {
    return null;
  }
}
