// 测试辅助:内存数据库与面板构造。

import { openDb, type DB } from './db';
import { createPanel, type Panel } from './panels/repo';

export function memoryDb(): DB {
  return openDb(':memory:');
}

export function addPanel(db: DB, name: string, baseUrl = `https://${name}.example:2053/path`): Panel {
  return createPanel(db, { name, base_url: baseUrl, token: 't' }, 0);
}
