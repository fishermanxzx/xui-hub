// 流量历史只保留最近 N 天:按小时的流量记录和计数回退审计,更早的删掉。
// 客户的已用量记在 customers 表,不受影响。

import type { DB } from '../db';

const DAY_MS = 86_400_000;

export function pruneHistory(db: DB, days: number, now = Date.now()): { hourly: number; resets: number } {
  const cutoff = now - days * DAY_MS;
  return db.transaction(() => ({
    hourly: db.prepare('DELETE FROM traffic_hourly WHERE hour < ?').run(cutoff).changes,
    resets: db.prepare('DELETE FROM counter_resets WHERE at < ?').run(cutoff).changes,
  }))();
}
