// 每轮同步后看看有什么要提醒的:面板掉线 / 恢复、客户被停用 / 恢复、快到期、流量快用完、按月清零、面板 / SOCKS 快到期。
// 同一件事只提醒一次(notified 表记 key);面板掉线记成 panel_down:<id>,恢复时清掉。

import { type CustomerView, listCustomers } from '../customers/repo';
import type { DB } from '../db';
import type { EnforceResult } from '../lines/enforce';
import { listPanels, type Panel } from '../panels/repo';
import { listSocks } from '../socks/repo';
import type { Settings } from '../settings';
import { subIpsSince } from '../subscription/fetchLog';
import type { Message } from './send';

export function alreadyNotified(db: DB, key: string): boolean {
  return !!db.prepare('SELECT 1 FROM notified WHERE key = ?').get(key);
}

export function markNotified(db: DB, key: string, now = Date.now()): void {
  db.prepare('INSERT OR REPLACE INTO notified (key, at) VALUES (?, ?)').run(key, now);
}

export function unmarkNotified(db: DB, key: string): void {
  db.prepare('DELETE FROM notified WHERE key = ?').run(key);
}

/** 清掉某个前缀的记录(流量清零后「用到 90%」要能再提醒) */
export function forgetNotified(db: DB, prefix: string): void {
  db.prepare("DELETE FROM notified WHERE key LIKE ? || '%'").run(prefix);
}

/** 按天记的 key(疑似分享、每日备份)过了 30 天就没用了,清掉 */
export function pruneNotified(db: DB, now = Date.now()): void {
  db.prepare("DELETE FROM notified WHERE (key LIKE 'share:%' OR key LIKE 'backup:%') AND at < ?").run(now - 30 * 86_400_000);
}

const GB = 1024 ** 3;
const gb = (n: number) => `${(n / GB).toFixed(n >= 10 * GB ? 0 : 1)} GB`;
const fmtDate = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const STATE: Record<string, string> = { expired: '已到期', over_quota: '已超额' };

/** 一段时长的大概说法:不到 1 分钟 / 约 12 分钟 / 约 2 小时 5 分钟 / 约 3 天 4 小时 */
export function aboutDuration(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 1) return '不到 1 分钟';
  if (min < 60) return `约 ${min} 分钟`;
  const h = Math.floor(min / 60);
  if (h < 24) return `约 ${h} 小时${min % 60 ? ` ${min % 60} 分钟` : ''}`;
  return `约 ${Math.floor(h / 24)} 天${h % 24 ? ` ${h % 24} 小时` : ''}`;
}

/** 通知里的面板:「名字」(IP)。用检查时解析出的 IP,还没有就用地址里的主机名;名字里已经有就不重复 */
export function panelLabel(p: Pick<Panel, 'name' | 'base_url'> & { ip?: string | null }): string {
  let host = p.ip ?? '';
  if (!host) {
    try {
      host = new URL(p.base_url).hostname.replace(/^\[|\]$/g, '');
    } catch {}
  }
  return host && !p.name.includes(host) ? `「${p.name}」(${host})` : `「${p.name}」`;
}

/**
 * 面板连不上 / 恢复。连续 downAfter 次检查失败才发「连不上」(1 = 一失败就发);
 * 只有发过「连不上」的,恢复时才发「恢复正常」,没到次数就好了的两条都不发。
 * 发没发过记在 notified 表(panel_down:<面板 id>,at = 第一次失败的时间),进程重启后照样接得上。
 * before 是这轮检查之前的面板,用来在「恢复」里说之前是什么错、连续失败了几次。
 */
export function panelEvents(db: DB, before: Panel[], panels: Panel[], downAfter: number, now: number): Message[] {
  const prev = new Map(before.map((p) => [p.id, p]));
  const sentAt = db.prepare('SELECT at FROM notified WHERE key = ?');
  const out: Message[] = [];
  for (const p of panels) {
    const key = `panel_down:${p.id}`;
    const sent = sentAt.get(key) as { at: number } | undefined;
    if (p.check_error) {
      if (sent || p.check_fail_count < downAfter) continue;
      const since = p.check_fail_since ?? now;
      markNotified(db, key, since);
      const streak = p.check_fail_count > 1 ? `\n连续 ${p.check_fail_count} 次检查失败,已经${aboutDuration(now - since)}` : '';
      out.push({ event: 'panel_down', title: `面板${panelLabel(p)}连不上`, text: p.check_error + streak, at: now });
    } else if (sent) {
      unmarkNotified(db, key);
      const was = prev.get(p.id);
      const lines = [`断了${aboutDuration(now - sent.at)}` + (was && was.check_fail_count > 1 ? `,连续 ${was.check_fail_count} 次检查失败` : '')];
      if (was?.check_error) lines.push(`之前:${was.check_error}`);
      out.push({ event: 'panel_up', title: `面板${panelLabel(p)}恢复正常`, text: lines.join('\n'), at: now });
    }
  }
  return out;
}

/** 这轮停用 / 恢复了谁:按客户(id,名字可以重)汇总 */
export function enforceEvents(ops: EnforceResult[], customers: CustomerView[], now: number): Message[] {
  const out: Message[] = [];
  for (const action of ['disable', 'enable'] as const) {
    const byCustomer = new Map<number, EnforceResult[]>();
    for (const o of ops.filter((o) => o.ok && o.action === action)) byCustomer.set(o.customer_id, [...(byCustomer.get(o.customer_id) ?? []), o]);
    for (const [id, list] of byCustomer) {
      const c = customers.find((x) => x.id === id);
      const name = c?.name ?? list[0].customer;
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
        out.push({ event: 'customer_expiring', title: `客户「${c.name}」${days === 0 ? '今天' : `${days} 天后`}到期`, text: `到期日 ${fmtDate(c.expire_at)},${c.lines.length} 条线路` + (c.monthly_fee != null ? `,月费 ${c.monthly_fee}` : ''), at: now });
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

/** 「3 天后到期」「今天到期」「已过期 2 天」:按日历日算(服务器时区) */
function dueText(expireAt: number, now: number): string {
  const day0 = (ms: number) => new Date(new Date(ms).setHours(0, 0, 0, 0)).getTime();
  const days = Math.round((day0(expireAt) - day0(now)) / 86_400_000);
  return days > 0 ? `${days} 天后到期` : days === 0 ? '今天到期' : `已过期 ${-days} 天`;
}

/**
 * 面板 / SOCKS 快到期(只管填了到期日的):提前 asset_expiring_days 天,每个到期日提醒一次;续费后到期日变了会再提醒。
 * 写上会影响多少条线路 / 几位客户,忘了续费这些客户会一起断
 */
export function assetEvents(db: DB, s: Settings['notify'], now: number): Message[] {
  if (!s.asset_expiring) return [];
  const within = (at: number) => at > 0 && at - now <= s.asset_expiring_days * 86_400_000;
  const owners = db.prepare('SELECT COUNT(DISTINCT customer_id) AS n FROM lines WHERE panel_id = @id OR exit_panel_id = @id');
  const lineCount = db.prepare('SELECT (SELECT COUNT(*) FROM lines WHERE panel_id = @id) AS own, (SELECT COUNT(*) FROM lines WHERE exit_panel_id = @id) AS exit');
  const cost = (n: number | null) => (n != null ? `,月成本 ${n}` : '');
  const out: Message[] = [];
  for (const p of listPanels(db)) {
    if (!within(p.expire_at)) continue;
    const key = `asset_expiring:panel:${p.id}:${p.expire_at}`;
    if (alreadyNotified(db, key)) continue;
    markNotified(db, key, now);
    const { own, exit } = lineCount.get({ id: p.id }) as { own: number; exit: number };
    const { n } = owners.get({ id: p.id }) as { n: number };
    const use = own + exit ? `${own} 条线路${exit ? `,另有 ${exit} 条线路从它出` : ''}(${n} 位客户)` : '上面还没有线路';
    out.push({ event: 'panel_expiring', title: `面板${panelLabel(p)}${dueText(p.expire_at, now)}`, text: `到期日 ${fmtDate(p.expire_at)}${cost(p.monthly_cost)};${use}\n续了以后在后台点「续费」顺延到期日`, at: now });
  }
  for (const x of listSocks(db)) {
    if (!within(x.expire_at)) continue;
    const key = `asset_expiring:socks:${x.id}:${x.expire_at}`;
    if (alreadyNotified(db, key)) continue;
    markNotified(db, key, now);
    const use = x.seen_by ? `${x.seen_by} 条线路用到它(${x.customers} 位客户)` : '还没有线路用它';
    out.push({ event: 'socks_expiring', title: `SOCKS「${x.name}」${dueText(x.expire_at, now)}`, text: `到期日 ${fmtDate(x.expire_at)}${cost(x.monthly_cost)};${use}\n续了以后在后台点「续费」顺延到期日`, at: now });
  }
  return out;
}

/** used:清零前的计费用量 */
export function resetEvent(c: CustomerView, used: number, failed: number, now: number): Message {
  return {
    event: 'monthly_reset',
    title: `客户「${c.name}」已按月清零流量`,
    text: `${c.expire_at ? '跟着到期日每月重置' : `每月 ${c.reset_day} 号重置`},上一期用了 ${gb(used)}` + (failed ? `;${failed} 个客户端在面板上没清成(面板连不上等),本期照样从 0 算,面板上的计数下次清零时再清` : ''),
    at: now,
  };
}

/** 订阅疑似被分享:24 小时内从 N 个以上不同 IP 拉过。每位客户每天最多提醒一次 */
export function shareEvents(db: DB, s: Settings['notify'], now: number, customers = listCustomers(db)): Message[] {
  if (!s.sub_share) return [];
  const ips = subIpsSince(db, now - 86_400_000);
  const out: Message[] = [];
  for (const c of customers) {
    const list = ips.get(c.id) ?? [];
    if (list.length < s.sub_share_ips) continue;
    const key = `share:${c.id}:${fmtDate(now)}`;
    if (alreadyNotified(db, key)) continue;
    markNotified(db, key, now);
    out.push({
      event: 'sub_shared',
      title: `客户「${c.name}」的订阅 24 小时内被 ${list.length} 个 IP 拉取`,
      text: `可能被转给别人用了:${list.slice(0, 10).join('、')}${list.length > 10 ? ' 等' : ''}\n确认是分享的话,在后台重置他的订阅链接`,
      at: now,
    });
  }
  return out;
}
