// 客户页的搜索 / 过滤 / 排序(纯前端:客户列表本来就整个取回来)。

import { dueLevel } from './format';
import type { Customer } from './types';

export type CustomerSort = 'name' | 'expire' | 'used' | 'fee' | 'created' | 'fetched';
/** '' = 全部;soon = 7 天内到期(还没到期) */
export type CustomerStateFilter = '' | 'active' | 'soon' | 'over_quota' | 'expired';
export const CUSTOMER_SORTS: CustomerSort[] = ['name', 'expire', 'used', 'fee', 'created', 'fetched'];
export const CUSTOMER_STATES: Exclude<CustomerStateFilter, ''>[] = ['active', 'soon', 'over_quota', 'expired'];

export interface CustomerQuery {
  /** 搜名字、备注、线路 email、节点名 */
  q: string;
  /** 有线路在这些面板上(任一块;中转线路的入口和出口面板都算) */
  panels: number[];
  state: CustomerStateFilter;
  sort: CustomerSort;
  /** 反过来排 */
  reverse: boolean;
}

/** 各排序默认的方向:名字 A→Z、到期日近的在前;流量 / 月费 / 新建 / 拉订阅都是大的(新的)在前 */
const DESC: Record<CustomerSort, boolean> = { name: false, expire: false, used: true, fee: true, created: true, fetched: true };
/** 排序用的值;null = 没有(不限期、没填月费、没拉过订阅),不管正着反着都排最后 */
const KEY: Record<CustomerSort, (c: Customer) => number | string | null> = {
  name: (c) => c.name,
  expire: (c) => c.expire_at || null,
  used: (c) => c.used,
  fee: (c) => c.monthly_fee,
  created: (c) => c.created_at,
  fetched: (c) => c.sub_fetched_at || null,
};

/** 名字按中文排(汉字按拼音,字母不分大小写,数字按大小),不随浏览器语言变 */
const collator = new Intl.Collator('zh', { numeric: true, sensitivity: 'base' });
const byName = (a: Customer, b: Customer) => collator.compare(a.name, b.name) || a.id - b.id;

export const usesPanel = (c: Customer, ids: Set<number>) => c.lines.some((l) => ids.has(l.panel_id) || (l.exit_panel_id != null && ids.has(l.exit_panel_id)));

export function matchState(c: Customer, state: CustomerStateFilter, now = Date.now()): boolean {
  if (state === 'soon') return c.state !== 'expired' && dueLevel(c.expire_at, now) === 'warn';
  return !state || c.state === state;
}

export function queryCustomers(list: Customer[], f: CustomerQuery, now = Date.now()): Customer[] {
  const q = f.q.trim().toLowerCase();
  const panels = new Set(f.panels);
  const shown = list.filter(
    (c) =>
      (!q || [c.name, c.remark, ...c.lines.flatMap((l) => [l.email, l.node_name])].some((s) => s?.toLowerCase().includes(q))) &&
      (!panels.size || usesPanel(c, panels)) &&
      matchState(c, f.state, now),
  );
  const key = KEY[f.sort];
  const flip = DESC[f.sort] !== f.reverse;
  return shown.sort((a, b) => {
    const x = key(a);
    const y = key(b);
    if (x == null || y == null) return x == null && y == null ? byName(a, b) : x == null ? 1 : -1;
    const d = typeof x === 'string' ? collator.compare(x, String(y)) : x - (y as number);
    return (flip ? -d : d) || byName(a, b);
  });
}
