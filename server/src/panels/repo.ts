// 面板的增删改查。token 只在服务端使用,对外视图不含 token。

import type { DB } from '../db';

export type PanelRole = 'relay' | 'exit';

export interface Panel {
  id: number;
  name: string;
  base_url: string;
  token: string;
  ip: string | null;
  provider: string | null;
  role: PanelRole;
  monthly_cost: number | null;
  /** 机器到期时间(毫秒):null = 未填,0 = 不限期 */
  expire_at: number | null;
  enabled: boolean;
  created_at: number;
  last_sync_at: number | null;
  last_sync_ok_at: number | null;
  last_sync_error: string | null;
  client_count: number | null;
}

export type PanelView = Omit<Panel, 'token'>;

export interface PanelInput {
  name?: string;
  base_url?: string;
  token?: string;
  ip?: string | null;
  provider?: string | null;
  role?: PanelRole;
  monthly_cost?: number | null;
  expire_at?: number | null;
  enabled?: boolean;
}

export class InputError extends Error {}

function rowToPanel(row: any): Panel {
  return { ...row, enabled: row.enabled === 1 };
}

export function toPanelView(panel: Panel): PanelView {
  const { token: _token, ...view } = panel;
  return view;
}

export function normalizeBaseUrl(value: string): string {
  const text = value.trim().replace(/\/+$/, '');
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new InputError('base_url 不是有效 URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new InputError('base_url 必须是 http(s)');
  return text;
}

function optionalText(value: unknown): string | null {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

/** 金额(元):空 = 未填;保留两位小数 */
export function money(value: unknown, label: string): number | null {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new InputError(`${label}必须是大于等于 0 的数字`);
  return Math.round(n * 100) / 100;
}

/** 机器到期时间:空 = 未填,0 = 不限期,其余是毫秒时间戳 */
function expireAt(value: unknown): number | null {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new InputError('到期时间必须是大于等于 0 的整数(毫秒)');
  return n;
}

export function listPanels(db: DB): Panel[] {
  return (db.prepare('SELECT * FROM panels ORDER BY role DESC, name').all() as any[]).map(rowToPanel);
}

export function getPanel(db: DB, id: number): Panel | undefined {
  const row = db.prepare('SELECT * FROM panels WHERE id = ?').get(id);
  return row ? rowToPanel(row) : undefined;
}

export function createPanel(db: DB, input: PanelInput, now = Date.now()): Panel {
  const name = input.name?.trim();
  if (!name) throw new InputError('缺少面板名称');
  if (!input.base_url) throw new InputError('缺少 base_url');
  const token = input.token?.trim();
  if (!token) throw new InputError('缺少 token');
  // 类型必须明确给出,不按名称推断
  const role = input.role;
  if (role !== 'relay' && role !== 'exit') throw new InputError('缺少类型:中转(relay)或落地(exit)');
  if (db.prepare('SELECT 1 FROM panels WHERE name = ?').get(name)) throw new InputError(`面板名称已存在:${name}`);
  const info = db
    .prepare(
      // id 不复用已删面板的:流量记录按 panel_id 存,复用会把旧面板的历史流量算到新面板头上
      `INSERT INTO panels (id, name, base_url, token, ip, provider, role, monthly_cost, expire_at, enabled, created_at)
       VALUES ((SELECT COALESCE(MAX(id), 0) + 1 FROM (SELECT id FROM panels UNION ALL SELECT id FROM deleted_panels)),
               ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      name,
      normalizeBaseUrl(input.base_url),
      token,
      optionalText(input.ip),
      optionalText(input.provider),
      role,
      money(input.monthly_cost, '月成本'),
      expireAt(input.expire_at),
      input.enabled === false ? 0 : 1,
      now,
    );
  return getPanel(db, Number(info.lastInsertRowid))!;
}

export function updatePanel(db: DB, id: number, patch: PanelInput): Panel {
  const current = getPanel(db, id);
  if (!current) throw new InputError('面板不存在');
  const name = patch.name !== undefined ? patch.name.trim() : current.name;
  if (!name) throw new InputError('面板名称不能为空');
  if (name !== current.name && db.prepare('SELECT 1 FROM panels WHERE name = ?').get(name)) {
    throw new InputError(`面板名称已存在:${name}`);
  }
  if (patch.role !== undefined && patch.role !== 'relay' && patch.role !== 'exit') throw new InputError('role 只能是 relay 或 exit');
  const token = patch.token?.trim() || current.token; // 留空表示不修改 token
  db.prepare(
    `UPDATE panels SET name = ?, base_url = ?, token = ?, ip = ?, provider = ?, role = ?, monthly_cost = ?, expire_at = ?, enabled = ?
     WHERE id = ?`,
  ).run(
    name,
    patch.base_url !== undefined ? normalizeBaseUrl(patch.base_url) : current.base_url,
    token,
    patch.ip !== undefined ? optionalText(patch.ip) : current.ip,
    patch.provider !== undefined ? optionalText(patch.provider) : current.provider,
    patch.role ?? current.role,
    patch.monthly_cost !== undefined ? money(patch.monthly_cost, '月成本') : current.monthly_cost,
    patch.expire_at !== undefined ? expireAt(patch.expire_at) : current.expire_at,
    (patch.enabled ?? current.enabled) ? 1 : 0,
    id,
  );
  return getPanel(db, id)!;
}

/** 删除面板;名字和类型记进 deleted_panels,历史流量里还能显示、还能分中转 / 落地 */
export function deletePanel(db: DB, id: number, now = Date.now()): void {
  const bound = db.prepare('SELECT COUNT(*) AS n FROM bindings WHERE panel_id = ?').get(id) as { n: number };
  if (bound.n > 0) throw new InputError(`该面板上还有 ${bound.n} 条客户线路,先解绑再删除`);
  db.transaction(() => {
    const row = db.prepare('SELECT name, role FROM panels WHERE id = ?').get(id) as { name: string; role: PanelRole } | undefined;
    if (!row) throw new InputError('面板不存在');
    db.prepare('INSERT OR REPLACE INTO deleted_panels (id, name, role, deleted_at) VALUES (?, ?, ?, ?)').run(id, row.name, row.role, now);
    db.prepare('DELETE FROM panels WHERE id = ?').run(id);
  })();
}
