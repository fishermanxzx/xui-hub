// 每轮同步后看看有什么要提醒的:面板掉线 / 恢复、客户被停用 / 恢复、快到期、流量快用完、按月清零。
// 同一件事只提醒一次(notified 表记 key);面板掉线 / 恢复按状态变化判断,不用记。

import { type CustomerView, listCustomers } from '../customers/repo';
import type { DB } from '../db';
import type { EnforceResult } from '../lines/enforce';
import type { Panel } from '../panels/repo';
import type { Settings } from '../settings';
import type { Message } from './send';

export function alreadyNotified(db: DB, key: string): boolean {
  return !!db.prepare('SELECT 1 FROM notified WHERE key = ?').get(key);
}

export function markNotified(db: DB, key: string, now = Date.now()): void {
  db.prepare('INSERT OR REPLACE INTO notified (key, at) VALUES (?, ?)').run(key, now);
}

/** 清掉某个前缀的记录(流量清零后「用到 90%」要能再提醒) */
export function forgetNotified(db: DB, prefix: string): void {
  db.prepare("DELETE FROM notified WHERE key LIKE ? || '%'").run(prefix);
}

const GB = 1024 ** 3;
const gb = (n: number) => `${(n / GB).toFixed(n >= 10 * GB ? 0 : 1)} GB`;
const fmtDate = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const STATE: Record<string, string> = { expired: '已到期', over_quota: '已超额' };

/** 面板连通性变化:上一轮正常这轮连不上(或反过来) */
export function panelEvents(before: Panel[], after: Panel[], now: number): Message[] {
  const prev = new Map(before.map((p) => [p.id, p.check_error]));
  const out: Message[] = [];
  for (const p of after) {
    if (!prev.has(p.id)) continue;
    const was = prev.get(p.id);
    if (!was && p.check_error) out.push({ event: 'panel_down', title: `面板「${p.name}」连不上`, text: p.check_error, at: now });
    else if (was && !p.check_error) out.push({ event: 'panel_up', title: `面板「${p.name}」恢复正常`, text: `之前:${was}`, at: now });
  }
  return out;
}

/** 这轮停用 / 恢复了谁:按客户汇总 */
export function enforceEvents(ops: EnforceResult[], customers: CustomerView[], now: number): Message[] {
  const out: Message[] = [];
  for (const action of ['disable', 'enable'] as const) {
    const byCustomer = new Map<string, EnforceResult[]>();
    for (const o of ops.filter((o) => o.ok && o.action === action)) byCustomer.set(o.customer, [...(byCustomer.get(o.customer) ?? []), o]);
    for (const [name, list] of byCustomer) {
      const c = customers.find((x) => x.name === name);
      const where = list.map((o) => `${o.panel} 上的 ${o.email}`).join('、');
      if (action === 'disable') {
        const why = c ? STATE[c.state] ?? '' : '';
        const detail = c ? (c.state === 'expired' ? `到期日 ${fmtDate(c.expire_at)}` : `已用 ${gb(c.used)} / ${gb(c.quota_bytes)}`) : '';
        out.push({ event: 'customer_disabled', title: `客户「${name}」${why ? why + ',' : ''}已停用 ${list.length} 个客户端`, text: [detail, where].filter(Boolean).join('\n'), at: now });
      } else {
        out.push({ event: 'customer_enabled', title: `客户「${name}」恢复正常,已重新启用 ${list.length} 个客户端`, text: where, at: now });
      }
    }
  }
  return out;
}

/** 快到期、流量快用完:每位客户每个到期日 / 每个额度周期提醒一次 */
export function thresholdEvents(db: DB, s: Settings['notify'], now: number, customers = listCustomers(db)): Message[] {
  const out: Message[] = [];
  for (const c of customers) {
    if (c.state !== 'active') continue;
    if (s.expiring && c.expire_at > 0 && c.expire_at - now <= s.expiring_days * 86_400_000) {
      const key = `expiring:${c.id}:${c.expire_at}`;
      if (!alreadyNotified(db, key)) {
        markNotified(db, key, now);
        const days = Math.max(0, Math.ceil((c.expire_at - now) / 86_400_000));
        out.push({ event: 'customer_expiring', title: `客户「${c.name}」${days === 0 ? '今天' : `${days} 天后`}到期`, text: `到期日 ${fmtDate(c.expire_at)},${c.lines.length} 条线路`, at: now });
      }
    }
    if (s.quota_warn && c.quota_bytes > 0 && c.used >= (c.quota_bytes * s.quota_warn_pct) / 100) {
      const key = `quota:${c.id}:${c.quota_bytes}:${c.last_reset_at}`;
      if (!alreadyNotified(db, key)) {
        markNotified(db, key, now);
        out.push({ event: 'customer_quota', title: `客户「${c.name}」流量已用 ${Math.floor((c.used / c.quota_bytes) * 100)}%`, text: `已用 ${gb(c.used)} / ${gb(c.quota_bytes)}`, at: now });
      }
    }
  }
  return out;
}

export function resetEvent(c: CustomerView, failed: number, now: number): Message {
  return {
    event: 'monthly_reset',
    title: `客户「${c.name}」已按月清零流量`,
    text: `每月 ${c.reset_day} 号清零,本期之前已用 ${gb(c.used)}` + (failed ? `;${failed} 个客户端没清成,下轮再试` : ''),
    at: now,
  };
}
