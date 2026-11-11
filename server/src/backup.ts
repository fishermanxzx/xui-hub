// 备份 / 恢复:备份 = SQLite 在线备份出一份完整的 hub.db;恢复 = 把上传的库文件放到 hub.db.restore,
// 退出进程由 systemd / Docker 拉起,启动时先把它换成正式的 hub.db(旧库留一份 .bak)。

import Database from 'better-sqlite3';
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MIGRATIONS, type DB } from './db';
import { InputError } from './panels/repo';

export const DB_FILE = 'hub.db';
const RESTORE_FILE = 'hub.db.restore';

export function backupName(now = Date.now()): string {
  const d = new Date(now);
  const p = (n: number) => String(n).padStart(2, '0');
  return `xui-hub-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.db`;
}

/** 当前数据库的完整拷贝(WAL 里没落盘的也包含) */
export async function backupBuffer(db: DB): Promise<Buffer> {
  const dir = mkdtempSync(join(tmpdir(), 'xui-hub-backup-'));
  const file = join(dir, 'backup.db');
  try {
    await db.backup(file);
    return readFileSync(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export interface BackupInfo {
  version: number;
  panels: number;
  customers: number;
  lines: number;
}

/** 看一眼上传的是不是 xui-hub 的库:SQLite 头、版本不比当前新、有 panels 表 */
export function inspectBackup(data: Buffer): BackupInfo {
  if (data.length < 100 || data.subarray(0, 16).toString('latin1') !== 'SQLite format 3\0') throw new InputError('这不是 SQLite 数据库文件');
  const dir = mkdtempSync(join(tmpdir(), 'xui-hub-restore-'));
  const file = join(dir, 'check.db');
  try {
    writeFileSync(file, data);
    const db = new Database(file, { readonly: true });
    try {
      const version = db.pragma('user_version', { simple: true }) as number;
      if (version > MIGRATIONS.length) throw new InputError(`备份来自更新的版本(数据库版本 ${version},当前支持到 ${MIGRATIONS.length}),先升级 xui-hub`);
      const count = (table: string) => {
        try {
          return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
        } catch {
          return -1;
        }
      };
      const panels = count('panels');
      if (panels < 0) throw new InputError('这不是 xui-hub 的数据库(没有 panels 表)');
      return { version, panels, customers: Math.max(0, count('customers')), lines: Math.max(0, count('lines')) };
    } finally {
      db.close();
    }
  } catch (e) {
    if (e instanceof InputError) throw e;
    throw new InputError(`读不了这个文件:${e instanceof Error ? e.message : e}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 放好待恢复的文件,重启后生效 */
export function stageRestore(dataDir: string, data: Buffer): void {
  writeFileSync(join(dataDir, RESTORE_FILE), data, { mode: 0o600 });
}

/** 启动时调用:有待恢复的文件就换上去(旧库改名留着),返回是否恢复了 */
export function applyPendingRestore(dataDir: string, now = Date.now()): boolean {
  const pending = join(dataDir, RESTORE_FILE);
  if (!existsSync(pending)) return false;
  const live = join(dataDir, DB_FILE);
  if (existsSync(live)) renameSync(live, `${live}.bak-${backupName(now).slice(8, -3)}`);
  for (const suffix of ['-wal', '-shm']) if (existsSync(live + suffix)) unlinkSync(live + suffix);
  renameSync(pending, live);
  return true;
}
