// 面板的增删改查。token 只在服务端使用,对外视图不含 token。

import type { DB } from '../db';

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
  inbound_count: number | null;
  client_count: number | null;
  /** 最近一次检查读到的面板版本、Xray 内核版本和状态(running / stopped / error) */
  panel_version: string | null;
  xray_version: string | null;
  xray_state: string | null;
  /** 月成本,null = 没填 */
  monthly_cost: number | null;
  /** 到期时间(毫秒),0 = 没填 / 不限期 */
  expire_at: number;
}

/** line_count:挂在这块面板上的客户线路数;exit_line_count:旧版本留下的、以它为出口的线路数 */
export type PanelView = Omit<Panel, 'token'> & { line_count: number; exit_line_count: number };

export interface PanelInput {
  name?: string;
  base_url?: string;
  token?: string;
  monthly_cost?: unknown;
  expire_at?: unknown;
}

export class InputError extends Error {}

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

export function panelUsage(db: DB, id: number): { line_count: number; exit_line_count: number } {
  return db
    .prepare('SELECT (SELECT COUNT(*) FROM lines WHERE panel_id = @id) AS line_count, (SELECT COUNT(*) FROM lines WHERE exit_panel_id = @id) AS exit_line_count')
    .get({ id }) as { line_count: number; exit_line_count: number };
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
  return db.prepare('SELECT * FROM panels ORDER BY name').all() as Panel[];
}

export function getPanel(db: DB, id: number): Panel | undefined {
  return db.prepare('SELECT * FROM panels WHERE id = ?').get(id) as Panel | undefined;
}

export function createPanel(db: DB, input: PanelInput, now = Date.now()): Panel {
  const name = input.name?.trim();
  if (!name) throw new InputError('缺少面板名称');
  if (!input.base_url) throw new InputError('缺少面板地址');
  const token = input.token?.trim();
  if (!token) throw new InputError('缺少 API token');
  if (db.prepare('SELECT 1 FROM panels WHERE name = ?').get(name)) throw new InputError(`面板名称已存在:${name}`);
  const info = db
    .prepare('INSERT INTO panels (name, base_url, token, monthly_cost, expire_at, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(name, normalizeBaseUrl(input.base_url), token, validCost(input.monthly_cost), validExpire(input.expire_at), now);
  return getPanel(db, Number(info.lastInsertRowid))!;
}

export function updatePanel(db: DB, id: number, patch: PanelInput): Panel {
  const current = getPanel(db, id);
  if (!current) throw new InputError('面板不存在');
  const name = patch.name !== undefined ? patch.name.trim() : current.name;
  if (!name) throw new InputError('面板名称不能为空');
  if (name !== current.name && db.prepare('SELECT 1 FROM panels WHERE name = ?').get(name)) throw new InputError(`面板名称已存在:${name}`);
  db.prepare('UPDATE panels SET name = ?, base_url = ?, token = ?, monthly_cost = ?, expire_at = ? WHERE id = ?').run(
    name,
    patch.base_url !== undefined ? normalizeBaseUrl(patch.base_url) : current.base_url,
    patch.token?.trim() || current.token, // 留空表示不修改 token
    patch.monthly_cost !== undefined ? validCost(patch.monthly_cost) : current.monthly_cost,
    patch.expire_at !== undefined ? validExpire(patch.expire_at) : current.expire_at,
    id,
  );
  return getPanel(db, id)!;
}

/** 删面板(只是不再接入,面板上的东西不动)。挂在它上面的客户线路记录会跟着删掉,所以有线路时要 force 才删 */
export function deletePanel(db: DB, id: number, force = false): void {
  const { line_count } = panelUsage(db, id);
  if (line_count && !force) throw new InputError(`这块面板上还有 ${line_count} 条客户线路,删面板会把这些线路记录一并删掉;先删线路,或确认后强制删除`);
  if (!db.prepare('DELETE FROM panels WHERE id = ?').run(id).changes) throw new InputError('面板不存在');
}

export type CheckResult =
  | { ok: true; inbounds: number; clients: number; panel_version?: string; xray_version?: string; xray_state?: string }
  | { ok: false; error: string };

export function recordCheck(db: DB, id: number, result: CheckResult, now = Date.now()): void {
  if (result.ok) {
    db.prepare(
      `UPDATE panels SET checked_at = ?, check_ok_at = ?, check_error = NULL, inbound_count = ?, client_count = ?,
              panel_version = COALESCE(?, panel_version), xray_version = COALESCE(?, xray_version), xray_state = COALESCE(?, xray_state)
       WHERE id = ?`,
    ).run(now, now, result.inbounds, result.clients, result.panel_version ?? null, result.xray_version ?? null, result.xray_state ?? null, id);
  } else {
    db.prepare('UPDATE panels SET checked_at = ?, check_error = ? WHERE id = ?').run(now, result.error.slice(0, 500), id);
  }
}
