// 测试辅助:内存数据库与快照构造。

import { openDb, type DB } from './db';
import { createPanel, getPanel, type Panel, type PanelRole } from './panels/repo';
import type { ClientSnapshot } from './xui/normalize';

export function memoryDb(): DB {
  return openDb(':memory:');
}

export function addPanel(db: DB, name: string, role: PanelRole = 'exit'): Panel {
  return createPanel(db, { name, base_url: `https://${name}.example:2053/path`, token: 't', role }, 0);
}

export function refreshPanel(db: DB, panel: Panel): Panel {
  return getPanel(db, panel.id)!;
}

export function snap(email: string, up: number, down: number, extra: Partial<ClientSnapshot> = {}): ClientSnapshot {
  return {
    email,
    comment: '',
    enable: true,
    totalBytes: 0,
    expiryMs: 0,
    inboundIds: [1],
    up,
    down,
    lastOnline: 0,
    ...extra,
  };
}

