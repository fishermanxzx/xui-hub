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
}

export type PanelView = Omit<Panel, 'token'>;

export interface PanelInput {
  name?: string;
  base_url?: string;
  token?: string;
}

export class InputError extends Error {}

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
    .prepare('INSERT INTO panels (name, base_url, token, created_at) VALUES (?, ?, ?, ?)')
    .run(name, normalizeBaseUrl(input.base_url), token, now);
  return getPanel(db, Number(info.lastInsertRowid))!;
}

export function updatePanel(db: DB, id: number, patch: PanelInput): Panel {
  const current = getPanel(db, id);
  if (!current) throw new InputError('面板不存在');
  const name = patch.name !== undefined ? patch.name.trim() : current.name;
  if (!name) throw new InputError('面板名称不能为空');
  if (name !== current.name && db.prepare('SELECT 1 FROM panels WHERE name = ?').get(name)) throw new InputError(`面板名称已存在:${name}`);
  db.prepare('UPDATE panels SET name = ?, base_url = ?, token = ? WHERE id = ?').run(
    name,
    patch.base_url !== undefined ? normalizeBaseUrl(patch.base_url) : current.base_url,
    patch.token?.trim() || current.token, // 留空表示不修改 token
    id,
  );
  return getPanel(db, id)!;
}

export function deletePanel(db: DB, id: number): void {
  if (!db.prepare('DELETE FROM panels WHERE id = ?').run(id).changes) throw new InputError('面板不存在');
}

export type CheckResult = { ok: true; inbounds: number; clients: number } | { ok: false; error: string };

export function recordCheck(db: DB, id: number, result: CheckResult, now = Date.now()): void {
  if (result.ok) {
    db.prepare('UPDATE panels SET checked_at = ?, check_ok_at = ?, check_error = NULL, inbound_count = ?, client_count = ? WHERE id = ?').run(
      now,
      now,
      result.inbounds,
      result.clients,
      id,
    );
  } else {
    db.prepare('UPDATE panels SET checked_at = ?, check_error = ? WHERE id = ?').run(now, result.error.slice(0, 500), id);
  }
}
