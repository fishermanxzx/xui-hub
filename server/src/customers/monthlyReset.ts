// 每月按到期日重置流量:开启后,每月到期日那天(该月没有那天取最后一天)的 0 点(按时区)自动做一次"已用清零"。
// 已停用、已到期、不限期的客户不重置;开启前已经过去的重置日不补。

import type { DB } from '../db';
import type { Panel } from '../panels/repo';
import { operateLines, type LineOpResult, type PanelWriter } from './panelOps';
import { customerState, getCustomer, resetUsage } from './repo';

const MIN_MS = 60_000;

/** 某年某月(按时区)的重置时刻:到期日那天的 0 点;该月没有那天取最后一天 */
function boundary(day: number, y: number, m: number, tzOffsetMin: number): number {
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return Date.UTC(y, m, Math.min(day, last)) - tzOffsetMin * MIN_MS;
}

function expireDay(expireAt: number, tzOffsetMin: number): number {
  return new Date(expireAt + tzOffsetMin * MIN_MS).getUTCDate();
}

/** now 之前(含)最近的一个重置时刻 */
export function lastResetAt(expireAt: number, now: number, tzOffsetMin: number): number {
  const day = expireDay(expireAt, tzOffsetMin);
  const t = new Date(now + tzOffsetMin * MIN_MS);
  const here = boundary(day, t.getUTCFullYear(), t.getUTCMonth(), tzOffsetMin);
  return here <= now ? here : boundary(day, t.getUTCFullYear(), t.getUTCMonth() - 1, tzOffsetMin);
}

/** now 之后的下一个重置时刻 */
export function nextResetAt(expireAt: number, now: number, tzOffsetMin: number): number {
  const day = expireDay(expireAt, tzOffsetMin);
  const t = new Date(now + tzOffsetMin * MIN_MS);
  const here = boundary(day, t.getUTCFullYear(), t.getUTCMonth(), tzOffsetMin);
  return here > now ? here : boundary(day, t.getUTCFullYear(), t.getUTCMonth() + 1, tzOffsetMin);
}

/**
 * 已用清零:先清面板上各线路的流量,再清本地(之后同步时面板计数器变小按"重置"处理,清零以后的用量照常计入)。
 * 清零后客户是正常的(没停用、没到期)就同时启用线路,超额停掉的因此恢复。
 */
export async function resetCustomerUsage(db: DB, id: number, clientFor: (panel: Panel) => PanelWriter, now = Date.now()): Promise<LineOpResult[]> {
  const c = getCustomer(db, id, now)!;
  const enable = customerState({ ...c, used: 0 }, now) === 'active';
  const lines = await operateLines(db, id, enable ? { resetTraffic: true, enable: true } : { resetTraffic: true }, clientFor);
  resetUsage(db, id, now);
  return lines;
}

/** 每轮同步后执行:到了重置日、本周期还没清零过的客户,自动清零 */
export async function autoResetCustomers(
  db: DB,
  clientFor: (panel: Panel) => PanelWriter,
  tzOffsetMin: number,
  now = Date.now(),
  log: (line: string) => void = console.log,
): Promise<string[]> {
  const rows = db
    .prepare("SELECT id, name, expire_at, usage_reset_at, monthly_reset_at FROM customers WHERE monthly_reset_at > 0 AND status = 'active' AND expire_at > ?")
    .all(now) as { id: number; name: string; expire_at: number; usage_reset_at: number; monthly_reset_at: number }[];
  const done: string[] = [];
  for (const c of rows) {
    if (lastResetAt(c.expire_at, now, tzOffsetMin) <= Math.max(c.usage_reset_at, c.monthly_reset_at)) continue;
    const lines = await resetCustomerUsage(db, c.id, clientFor, now);
    done.push(c.name);
    const failed = lines.filter((l) => l.error);
    log(`[每月重置] 客户「${c.name}」已用清零,${lines.length} 条线路` + (failed.length ? `,${failed.length} 条面板上没清成:${failed.map((l) => `${l.panel} ${l.error}`).join(';')}` : ''));
  }
  return done;
}
