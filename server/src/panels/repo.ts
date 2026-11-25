// 面板的增删改查。token 只在服务端使用,对外视图不含 token。

import { nextId, type DB } from '../db';
import { validNodeName } from '../subscription/nodeName';

export interface Panel {
  id: number;
  name: string;
  base_url: string;
  token: string;
  created_at: number;
  /** 最近一次连通性检查 */
  checked_at: number | null;
  check_ok_at: number | null;
  check_error: string | null;
  /** 连续失败了几次、第一次失败的时间(成功一次就清零 / 清空) */
  check_fail_count: number;
  check_fail_since: number | null;
  inbound_count: number | null;
  client_count: number | null;
  /** 最近一次检查读到的面板版本、Xray 内核版本和状态(running / stopped / error) */
  panel_version: string | null;
  xray_version: string | null;
  xray_state: string | null;
  /** 面板地址解析出的 IP(地址本身是 IP 就是它),null = 还没解析到 */
  ip: string | null;
  /** 月成本,null = 没填 */
  monthly_cost: number | null;
  /** 到期时间(毫秒),0 = 没填 / 不限期 */
  expire_at: number;
  /** 节点名:这块面板上没单独设节点名的线路在订阅里用它;空 = 用面板生成的名字 */
  node_name: string;
  /** 标签(面板页 / 客户页按标签筛) */
  tags: string[];
  /** 流量倍率:这块面板上线路的计费用量 = 实际流量 × 倍率,默认 1 */
  traffic_ratio: number;
  /** 地理位置(面板页的地球用):坐标 null = 还没有;city / country(两位代码)可能为空 */
  geo_lat: number | null;
  geo_lng: number | null;
  geo_city: string;
  geo_country: string;
  /** 手动填的坐标(不再按 IP 自动查) */
  geo_manual: boolean;
  /** 自动查的是哪个 IP;上次查的时间;没查到的原因 */
  geo_ip: string;
  geo_at: number;
  geo_error: string;
}

/** line_count:挂在这块面板上的客户线路数;exit_line_count:旧版本留下的、以它为出口的线路数 */
export type PanelView = Omit<Panel, 'token'> & { line_count: number; exit_line_count: number; customer_count: number };

export interface PanelInput {
  name?: string;
  base_url?: string;
  token?: string;
  monthly_cost?: unknown;
  expire_at?: unknown;
  node_name?: unknown;
  /** 字符串数组,或用逗号 / 空格分开的一串 */
  tags?: unknown;
  /** 流量倍率:空 = 1 */
  traffic_ratio?: unknown;
  /** 位置:{ lat, lng, city? } = 手动填的坐标;null / 空 = 按 IP 自动查;不给 = 不改 */
  location?: unknown;
}

export class InputError extends Error {}

/** 标签:去掉首尾空白和重复的,每个最多 20 个字,最多 20 个;不能有逗号、换行 */
export function validTags(value: unknown): string[] {
  if (value == null || value === '') return [];
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[,,\s]+/) : null;
  if (!raw) throw new InputError('标签要是字符串数组,或用逗号 / 空格分开');
  const out: string[] = [];
  for (const x of raw) {
    if (typeof x !== 'string') throw new InputError('标签要是文字');
    const tag = x.trim();
    if (!tag) continue;
    if (tag.length > 20) throw new InputError(`标签「${tag.slice(0, 20)}…」太长,最多 20 个字`);
    if (/[,,\u0000-\u001f\u007f]/.test(tag)) throw new InputError('标签里不能有逗号、换行等字符');
    if (!out.includes(tag)) out.push(tag);
  }
  if (out.length > 20) throw new InputError('标签最多 20 个');
  return out;
}

function parseTags(v: unknown): string[] {
  try {
    const r = typeof v === 'string' ? JSON.parse(v) : [];
    return Array.isArray(r) ? r.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}
const toPanel = (row: any): Panel => ({ ...row, tags: parseTags(row.tags), traffic_ratio: row.traffic_ratio ?? 1, geo_manual: !!row.geo_manual });

/** 手动填的位置:纬度 -90~90、经度 -180~180,地点名最多 40 字;null / 空 = 不手动填(按 IP 自动查) */
export function validLocation(value: unknown): { lat: number; lng: number; city: string } | null {
  if (value == null || value === '') return null;
  if (typeof value !== 'object') throw new InputError('位置要是 { lat, lng, city }');
  const v = value as Record<string, unknown>;
  const lat = Number(v.lat);
  const lng = Number(v.lng);
  if (v.lat == null || v.lat === '' || !Number.isFinite(lat) || lat < -90 || lat > 90) throw new InputError('纬度要是 -90 到 90 的数');
  if (v.lng == null || v.lng === '' || !Number.isFinite(lng) || lng < -180 || lng > 180) throw new InputError('经度要是 -180 到 180 的数');
  if (v.city != null && typeof v.city !== 'string') throw new InputError('地点名要是文字');
  const city = String(v.city ?? '').trim();
  if (city.length > 40) throw new InputError('地点名最多 40 个字');
  return { lat: Math.round(lat * 1e5) / 1e5, lng: Math.round(lng * 1e5) / 1e5, city };
}

/** 改位置(面板 / SOCKS 共用):手动填的直接存;改回自动就清掉,下次打开地球时按 IP 重查 */
export function setGeoLocation(db: DB, table: 'panels' | 'socks_proxies', id: number, loc: ReturnType<typeof validLocation>): void {
  if (loc) db.prepare(`UPDATE ${table} SET geo_manual = 1, geo_lat = ?, geo_lng = ?, geo_city = ?, geo_country = '', geo_ip = '', geo_at = 0, geo_error = '' WHERE id = ?`).run(loc.lat, loc.lng, loc.city, id);
  else db.prepare(`UPDATE ${table} SET geo_manual = 0, geo_lat = NULL, geo_lng = NULL, geo_city = '', geo_country = '', geo_ip = '', geo_at = 0, geo_error = '' WHERE id = ? AND geo_manual = 1`).run(id);
}
const setLocation = (db: DB, id: number, loc: ReturnType<typeof validLocation>) => setGeoLocation(db, 'panels', id, loc);

/** 流量倍率:0.01 到 100,保留两位小数;空 = 1 */
export function validRatio(value: unknown): number {
  if (value == null || value === '') return 1;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0.01 || n > 100) throw new InputError('流量倍率要是 0.01 到 100 之间的数,留空 = 1');
  return Math.round(n * 100) / 100;
}

/** 月成本 / 月费:空 = 没填(null);否则 0 到 1 亿之间,保留两位小数 */
export function validCost(value: unknown, label = '月成本'): number | null {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 1e8) throw new InputError(`${label}要是 0 到 1 亿之间的数字,留空 = 不填`);
  return Math.round(n * 100) / 100;
}

/** 到期时间(毫秒):空 = 0(没填 / 不限期) */
export function validExpire(value: unknown): number {
  if (value == null || value === '') return 0;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new InputError('到期时间要是毫秒时间戳,0 = 不限期');
  return n;
}

/** 面板上的线路条数、有线路在上面的客户数,以及出口经这块面板的线路(旧版本的落地面板出口)条数 */
export function panelUsage(db: DB, id: number): { line_count: number; exit_line_count: number; customer_count: number } {
  return db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM lines WHERE panel_id = @id) AS line_count,
              (SELECT COUNT(*) FROM lines WHERE exit_panel_id = @id) AS exit_line_count,
              (SELECT COUNT(DISTINCT customer_id) FROM lines WHERE panel_id = @id) AS customer_count`,
    )
    .get({ id }) as { line_count: number; exit_line_count: number; customer_count: number };
}

export function toPanelView(db: DB, panel: Panel): PanelView {
  const { token: _token, ...view } = panel;
  return { ...view, ...panelUsage(db, panel.id) };
}

export function normalizeBaseUrl(value: string): string {
  const text = value.trim().replace(/\/+$/, '');
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new InputError('面板地址不是有效 URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new InputError('面板地址必须是 http(s)');
  return text;
}

export function listPanels(db: DB): Panel[] {
  return (db.prepare('SELECT * FROM panels ORDER BY name').all() as any[]).map(toPanel);
}

export function getPanel(db: DB, id: number): Panel | undefined {
  const row = db.prepare('SELECT * FROM panels WHERE id = ?').get(id);
  return row ? toPanel(row) : undefined;
}

export function createPanel(db: DB, input: PanelInput, now = Date.now()): Panel {
  const name = input.name?.trim();
  if (!name) throw new InputError('缺少面板名称');
  if (!input.base_url) throw new InputError('缺少面板地址');
  const token = input.token?.trim();
  if (!token) throw new InputError('缺少 API token');
  if (db.prepare('SELECT 1 FROM panels WHERE name = ?').get(name)) throw new InputError(`面板名称已存在:${name}`);
  const values = [name, normalizeBaseUrl(input.base_url), token, validCost(input.monthly_cost), validExpire(input.expire_at), validNodeName(input.node_name), JSON.stringify(validTags(input.tags)), validRatio(input.traffic_ratio), now] as const;
  const loc = validLocation(input.location);
  const id = db.transaction(() => {
    const id = nextId(db, 'panels');
    db.prepare('INSERT INTO panels (id, name, base_url, token, monthly_cost, expire_at, node_name, tags, traffic_ratio, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, ...values);
    if (loc) setLocation(db, id, loc);
    return id;
  })();
  return getPanel(db, id)!;
}

export function updatePanel(db: DB, id: number, patch: PanelInput): Panel {
  const current = getPanel(db, id);
  if (!current) throw new InputError('面板不存在');
  const name = patch.name !== undefined ? patch.name.trim() : current.name;
  if (!name) throw new InputError('面板名称不能为空');
  if (name !== current.name && db.prepare('SELECT 1 FROM panels WHERE name = ?').get(name)) throw new InputError(`面板名称已存在:${name}`);
  const baseUrl = patch.base_url !== undefined ? normalizeBaseUrl(patch.base_url) : current.base_url;
  // 地址换了主机,旧 IP 不算数,下次检查再解析
  const hostChanged = new URL(baseUrl).hostname !== new URL(current.base_url).hostname;
  // 改节点名只改面板这一项:单独设过节点名的线路不跟着变(要统一用「线路都用这个节点名」)
  // 改倍率:这块面板上的线路本期已用当场按新倍率算(计费用量现算),已经结转的部分不动
  const loc = patch.location !== undefined ? validLocation(patch.location) : undefined;
  db.prepare(`UPDATE panels SET name = ?, base_url = ?, token = ?, monthly_cost = ?, expire_at = ?, node_name = ?, tags = ?, traffic_ratio = ?${hostChanged ? ', ip = NULL' : ''} WHERE id = ?`).run(
    name,
    baseUrl,
    patch.token?.trim() || current.token, // 留空表示不修改 token
    patch.monthly_cost !== undefined ? validCost(patch.monthly_cost) : current.monthly_cost,
    patch.expire_at !== undefined ? validExpire(patch.expire_at) : current.expire_at,
    patch.node_name !== undefined ? validNodeName(patch.node_name) : current.node_name,
    JSON.stringify(patch.tags !== undefined ? validTags(patch.tags) : current.tags),
    patch.traffic_ratio !== undefined ? validRatio(patch.traffic_ratio) : current.traffic_ratio,
    id,
  );
  if (loc !== undefined) setLocation(db, id, loc);
  return getPanel(db, id)!;
}

/**
 * 删面板记录(只是不再接入,面板上的东西不动;要连面板上的客户端一起删用 uninstallPanel)。
 * 挂在它上面的客户线路记录会跟着删掉,所以有线路时要 force 才删。
 * 名字和流量倍率留到 removed_panels,流量记录不删,id 也不会给新面板用
 */
export function deletePanel(db: DB, id: number, force = false, now = Date.now()): void {
  const { line_count } = panelUsage(db, id);
  if (line_count && !force) throw new InputError(`这块面板上还有 ${line_count} 条客户线路,删面板会把这些线路记录一并删掉(本期用掉的流量会留在客户的已用里);先删线路,或确认后强制删除`);
  db.transaction(() => {
    // 这些线路本期用掉的流量结转到各自客户身上,客户的已用不变;计费用量按这块面板现在的倍率折好存下
    db.prepare(
      `UPDATE customers SET
         carried_up = carried_up + (SELECT COALESCE(SUM(up), 0) FROM lines WHERE lines.customer_id = customers.id AND lines.panel_id = @id),
         carried_down = carried_down + (SELECT COALESCE(SUM(down), 0) FROM lines WHERE lines.customer_id = customers.id AND lines.panel_id = @id),
         carried_used_up = carried_used_up + (SELECT COALESCE(SUM(CAST(ROUND(up * @ratio) AS INTEGER)), 0) FROM lines WHERE lines.customer_id = customers.id AND lines.panel_id = @id),
         carried_used_down = carried_used_down + (SELECT COALESCE(SUM(CAST(ROUND(down * @ratio) AS INTEGER)), 0) FROM lines WHERE lines.customer_id = customers.id AND lines.panel_id = @id)
       WHERE id IN (SELECT customer_id FROM lines WHERE panel_id = @id)`,
    ).run({ id, ratio: getPanel(db, id)?.traffic_ratio ?? 1 });
    // 留下名字和倍率:流量页、自助页的每天用量还按它显示、计费
    db.prepare('INSERT OR REPLACE INTO removed_panels (id, name, traffic_ratio, removed_at) SELECT id, name, traffic_ratio, @now FROM panels WHERE id = @id').run({ id, now });
    if (!db.prepare('DELETE FROM panels WHERE id = @id').run({ id }).changes) throw new InputError('面板不存在');
    // 「发过连不上」的记录一起清掉
    db.prepare('DELETE FROM notified WHERE key = ?').run(`panel_down:${id}`);
  })();
}

export function recordIp(db: DB, id: number, ip: string): void {
  db.prepare('UPDATE panels SET ip = ? WHERE id = ?').run(ip, id);
}

export type CheckResult =
  | { ok: true; inbounds: number; clients: number; panel_version?: string; xray_version?: string; xray_state?: string }
  | { ok: false; error: string };

export function recordCheck(db: DB, id: number, result: CheckResult, now = Date.now()): void {
  if (result.ok) {
    db.prepare(
      `UPDATE panels SET checked_at = ?, check_ok_at = ?, check_error = NULL, check_fail_count = 0, check_fail_since = NULL, inbound_count = ?, client_count = ?,
              panel_version = COALESCE(?, panel_version), xray_version = COALESCE(?, xray_version), xray_state = COALESCE(?, xray_state)
       WHERE id = ?`,
    ).run(now, now, result.inbounds, result.clients, result.panel_version ?? null, result.xray_version ?? null, result.xray_state ?? null, id);
  } else {
    db.prepare(
      'UPDATE panels SET checked_at = ?, check_error = ?, check_fail_count = check_fail_count + 1, check_fail_since = COALESCE(check_fail_since, ?) WHERE id = ?',
    ).run(now, result.error.slice(0, 500), now, id);
  }
}
