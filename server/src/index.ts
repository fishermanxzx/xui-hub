// 入口:打开数据库,提供 /api 和前端静态页,定期检查面板连通性。

import express from 'express';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tcpOpen } from './clients/create';
import { openDb } from './db';
import { env, isLoopbackHost, PROJECT_ROOT } from './env';
import { loadSessionSecret } from './http/auth';
import { apiRouter } from './http/routes';
import { checkAllPanels } from './panels/check';
import type { Panel } from './panels/repo';
import { XUIClient } from './xui/client';

// 数据库含面板 token:新建文件只给当前用户读写
process.umask(0o077);

if (!isLoopbackHost(env.host) && !env.adminPassword) {
  console.error(`监听 ${env.host} 时必须设置 ADMIN_PASSWORD`);
  process.exit(1);
}

const db = openDb(join(env.dataDir, 'hub.db'));
const clientFor = (panel: Panel) => new XUIClient(panel, { timeoutMs: 15000 });

const app = express();
app.disable('x-powered-by');
app.set('etag', false);
// 反代经本机 / Docker 内网访问时取真实客户端 IP(登录限流按它计数)
app.set('trust proxy', ['loopback', 'uniquelocal']);
app.use(express.json({ limit: '1mb' }));
app.use('/api', apiRouter({ db, sessionSecret: loadSessionSecret(db), adminPassword: env.adminPassword, clientFor, probe: tcpOpen }));

const dist = resolve(PROJECT_ROOT, 'web/dist');
if (existsSync(dist)) {
  app.use(express.static(dist));
  app.get('*', (_req, res) => res.sendFile(join(dist, 'index.html')));
}

const server = app.listen(env.port, env.host, () => {
  console.log(`xui-hub listening on http://${env.host}:${env.port}` + (env.adminPassword ? '' : '(未设置 ADMIN_PASSWORD,不鉴权)'));
});

// 定期检查各面板连通性
const check = () => checkAllPanels(db, clientFor).catch((e) => console.error('检查面板失败', e));
void check();
const timer = setInterval(check, env.checkIntervalSec * 1000);

function shutdown() {
  clearInterval(timer);
  server.close(() => {
    db.close();
    process.exit(0);
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
