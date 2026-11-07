import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import { backupDatabase, latestSnapshot, pruneBackups } from './backups';
import { memoryDb } from './testUtil';

const DAY = 86_400_000;

function aged(path: string, mtime: number) {
  utimesSync(path, mtime / 1000, mtime / 1000);
}

test('删超过保留天数的快照、配置备份目录和文件,最新 3 个快照无论多旧都留着', () => {
  const dir = mkdtempSync(join(tmpdir(), 'xm2-backups-'));
  try {
    const now = 100 * DAY;
    const file = (name: string, daysAgo: number) => {
      writeFileSync(join(dir, name), 'x');
      aged(join(dir, name), now - daysAgo * DAY);
    };
    file('hub-a.db', 20);
    file('hub-b.db', 10);
    file('hub-c.db', 9);
    file('hub-d.db', 8);
    file('hub-e.db', 8.5);
    file('std-clients-1.json', 8);
    file('own-clients-2.json', 2);
    mkdirSync(join(dir, 'relay-old'));
    writeFileSync(join(dir, 'relay-old', '美国中转.json'), '{}');
    aged(join(dir, 'relay-old'), now - 30 * DAY);
    mkdirSync(join(dir, 'relay-new'));
    aged(join(dir, 'relay-new'), now - DAY);

    const removed = pruneBackups(dir, 7, now).sort();
    assert.deepEqual(removed, ['hub-a.db', 'hub-b.db', 'relay-old', 'std-clients-1.json']);
    assert.deepEqual(readdirSync(dir).sort(), ['hub-c.db', 'hub-d.db', 'hub-e.db', 'own-clients-2.json', 'relay-new']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('备份生成可打开的快照,并能读到最新快照', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'xm2-backups-'));
  try {
    assert.equal(latestSnapshot(dir), null);
    const db = memoryDb();
    db.prepare("INSERT INTO meta (key, value) VALUES ('x', 'y')").run();
    const file = await backupDatabase(db, dir, Date.UTC(2026, 10, 1));
    assert.match(file, /hub-2026-11-01T00-00-00-000Z\.db$/);
    assert.equal(latestSnapshot(dir)!.name, basename(file));
    assert.equal(pruneBackups(dir, 7).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
