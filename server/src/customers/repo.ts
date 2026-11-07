// 客户与线路的存取。线路 = 客户在某块面板上的一个 client,直连或中转(带出口)。

import type { DB } from '../db';
import { InputError } from '../panels/repo';

export type LineKind = 'direct' | 'relay';

export interface Line {
  id: number;
  customer_id: number;
  kind: LineKind;
  panel_id: number;
  panel_name: string;
  inbound_id: number;
  inbound_remark: string;
  protocol: string;
  email: string;
  exit_kind: 'panel' | 'socks' | null;
  exit_panel_id: number | null;
  exit_panel_name: string | null;
  exit_port: number | null;
  exit_socks_id: number | null;
  exit_socks_name: string | null;
  exit_label: string;
  created_at: number;
}

export interface Customer {
  id: number;
  name: string;
  remark: string;
  created_at: number;
  updated_at: number;
}

export type CustomerView = Customer & { lines: Line[] };

export interface CustomerInput {
  name?: unknown;
  remark?: unknown;
}

function validName(value: unknown): string {
  const v = String(value ?? '').trim();
  if (!v) throw new InputError('客户名称不能为空');
  if (v.length > 64) throw new InputError('客户名称不能超过 64 个字符');
  return v;
}

const LINE_SQL = `
  SELECT l.*, p.name AS panel_name, ep.name AS exit_panel_name, es.name AS exit_socks_name
  FROM lines l
  JOIN panels p ON p.id = l.panel_id
  LEFT JOIN panels ep ON ep.id = l.exit_panel_id
  LEFT JOIN socks_proxies es ON es.id = l.exit_socks_id`;

function toLine(row: any): Line {
  return {
    id: row.id,
    customer_id: row.customer_id,
    kind: row.kind,
    panel_id: row.panel_id,
    panel_name: row.panel_name,
    inbound_id: row.inbound_id,
    inbound_remark: row.inbound_remark,
    protocol: row.protocol,
    email: row.email,
    exit_kind: row.exit_kind ?? null,
    exit_panel_id: row.exit_panel_id ?? null,
    exit_panel_name: row.exit_panel_name ?? null,
    exit_port: row.exit_port ?? null,
    exit_socks_id: row.exit_socks_id ?? null,
    exit_socks_name: row.exit_socks_name ?? null,
    exit_label: row.exit_label,
    created_at: row.created_at,
  };
}

export function linesOf(db: DB, customerId: number): Line[] {
  return (db.prepare(`${LINE_SQL} WHERE l.customer_id = ? ORDER BY l.id`).all(customerId) as any[]).map(toLine);
}

export function getLine(db: DB, id: number): Line | undefined {
  const row = db.prepare(`${LINE_SQL} WHERE l.id = ?`).get(id);
  return row ? toLine(row) : undefined;
}

function withLines(db: DB, rows: any[]): CustomerView[] {
  return rows.map((c) => ({ ...c, lines: linesOf(db, c.id) }));
}

export function listCustomers(db: DB): CustomerView[] {
  return withLines(db, db.prepare('SELECT * FROM customers ORDER BY name COLLATE NOCASE').all() as any[]);
}

export function getCustomer(db: DB, id: number): CustomerView | undefined {
  const row = db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
  return row ? withLines(db, [row])[0] : undefined;
}

export function createCustomer(db: DB, input: CustomerInput, now = Date.now()): number {
  const info = db.prepare('INSERT INTO customers (name, remark, created_at, updated_at) VALUES (?, ?, ?, ?)').run(validName(input.name), String(input.remark ?? '').trim(), now, now);
  return Number(info.lastInsertRowid);
}

export function updateCustomer(db: DB, id: number, input: CustomerInput, now = Date.now()): void {
  const cur = db.prepare('SELECT * FROM customers WHERE id = ?').get(id) as any;
  if (!cur) throw new InputError('客户不存在');
  db.prepare('UPDATE customers SET name = ?, remark = ?, updated_at = ? WHERE id = ?').run(
    input.name === undefined ? cur.name : validName(input.name),
    input.remark === undefined ? cur.remark : String(input.remark ?? '').trim(),
    now,
    id,
  );
}

export function deleteCustomer(db: DB, id: number): void {
  if (!db.prepare('DELETE FROM customers WHERE id = ?').run(id).changes) throw new InputError('客户不存在');
}

export interface LineInsert {
  customer_id: number;
  kind: LineKind;
  panel_id: number;
  inbound_id: number;
  inbound_remark: string;
  protocol: string;
  email: string;
  exit_kind?: 'panel' | 'socks' | null;
  exit_panel_id?: number | null;
  exit_port?: number | null;
  exit_socks_id?: number | null;
  exit_label?: string;
}

export function addLine(db: DB, l: LineInsert, now = Date.now()): Line {
  const info = db
    .prepare(
      `INSERT INTO lines (customer_id, kind, panel_id, inbound_id, inbound_remark, protocol, email, exit_kind, exit_panel_id, exit_port, exit_socks_id, exit_label, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(l.customer_id, l.kind, l.panel_id, l.inbound_id, l.inbound_remark, l.protocol, l.email, l.exit_kind ?? null, l.exit_panel_id ?? null, l.exit_port ?? null, l.exit_socks_id ?? null, l.exit_label ?? '', now);
  return getLine(db, Number(info.lastInsertRowid))!;
}

export function deleteLine(db: DB, id: number): void {
  if (!db.prepare('DELETE FROM lines WHERE id = ?').run(id).changes) throw new InputError('线路不存在');
}
