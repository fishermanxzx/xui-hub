// 自动备份:每天一份数据库快照(hub-<时间>.db);备份目录里超过保留天数的东西
// (数据库快照、改面板 / 中转前留的配置备份等)删掉,但最新几个数据库快照无论多旧都留着。
// 配了异地备份时,最新的数据库快照再上传一份到对象存储。

import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { DB } from './db';
import { uploadBackup, type S3Target } from './offsite';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
/** 备份连续失败时也不至于把数据库快照删光 */
const KEEP_LATEST = 3;
const SNAPSHOT = /^hub-.*\.db$/;

export async function backupDatabase(db: DB, dir: string, now = Date.now()): Promise<string> {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = join(dir, `hub-${new Date(now).toISOString().replace(/[:.]/g, '-')}.db`);
  await db.backup(target);
  return target;
}

function entries(dir: string): { name: string; mtime: number }[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.map((name) => ({ name, mtime: statSync(join(dir, name)).mtimeMs }));
}

/** 最新一个数据库快照;没有返回 null */
export function latestSnapshot(dir: string): { name: string; mtime: number } | null {
  return entries(dir)
    .filter((e) => SNAPSHOT.test(e.name))
    .reduce<{ name: string; mtime: number } | null>((a, e) => (a && a.mtime >= e.mtime ? a : e), null);
}

/** 删掉超过 keepDays 天的备份,返回删掉的名称 */
export function pruneBackups(dir: string, keepDays: number, now = Date.now()): string[] {
  const all = entries(dir);
  const latest = new Set(
    all
      .filter((e) => SNAPSHOT.test(e.name))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, KEEP_LATEST)
      .map((e) => e.name),
  );
  const removed: string[] = [];
  for (const e of all) {
    if (latest.has(e.name) || now - e.mtime <= keepDays * DAY_MS) continue;
    rmSync(join(dir, e.name), { recursive: true, force: true });
    removed.push(e.name);
  }
  return removed;
}

/**
 * 每小时检查一次:最新快照超过一天就备份,备份成功(或不需要备份)后清理过期备份;
 * 配了异地备份时,最新快照还没上传过(含服务刚启动)就上传
 */
export function startDailyBackup(db: DB, dir: string, keepDays: number, offsite: S3Target | null = null): () => void {
  let uploaded = '';
  const tick = async () => {
    try {
      const last = latestSnapshot(dir);
      if (last == null || Date.now() - last.mtime >= DAY_MS) console.log('[自动备份]', await backupDatabase(db, dir));
      const removed = pruneBackups(dir, keepDays);
      if (removed.length) console.log('[自动备份] 删除过期备份:', removed.join(' '));
    } catch (e) {
      console.error('[自动备份] 失败:', e);
    }
    const latest = offsite && latestSnapshot(dir);
    if (!offsite || !latest || latest.name === uploaded) return;
    try {
      console.log('[异地备份] 已上传', await uploadBackup(offsite, join(dir, latest.name)));
      uploaded = latest.name;
    } catch (e) {
      console.error('[异地备份] 上传失败:', e instanceof Error ? e.message : e);
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), HOUR_MS);
  return () => clearInterval(timer);
}
