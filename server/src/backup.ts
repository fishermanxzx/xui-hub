// 命令行:在线备份数据库(服务运行中也可执行,得到一致的快照)。上线脚本 deploy.sh 每次部署前会调用。
// 用法:npm run backup -- [目标文件];默认写到 <DATA_DIR>/backups/hub-<时间>.db

import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { backupDatabase } from './backups';
import { openDb } from './db';
import { env } from './env';

process.umask(0o077);

const db = openDb(join(env.dataDir, 'hub.db'));
try {
  if (process.argv[2]) {
    const target = resolve(process.argv[2]);
    mkdirSync(dirname(target), { recursive: true });
    await db.backup(target);
    console.log(target);
  } else {
    console.log(await backupDatabase(db, join(env.dataDir, 'backups')));
  }
} finally {
  db.close();
}
