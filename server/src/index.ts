// 入口:打开数据库,提供 /api 和前端静态页,定期检查面板连通性。

import express from 'express';
import { existsSync, readFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { join, resolve } from 'node:path';
import { tcpOpen } from './clients/create';
import { openDb } from './db';
import { env, isLoopbackHost, PROJECT_ROOT } from './env';
import { loadSessionSecret } from './http/auth';
import { apiRouter } from './http/routes';
import { enforceCustomers } from './lines/enforce';
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

// 配了 TLS_CERT_FILE / TLS_KEY_FILE 就直接提供 HTTPS(证书续期后重启服务即可生效)
const server = env.tls ? createHttpsServer({ cert: readFileSync(env.tls.cert), key: readFileSync(env.tls.key) }, app) : createHttpServer(app);
server.listen(env.port, env.host, () => {
  console.log(`xui-hub listening on ${env.tls ? 'https' : 'http'}://${env.host}:${env.port}` + (env.adminPassword ? '' : '(未设置 ADMIN_PASSWORD,不鉴权)'));
});

// 定期:检查各面板(顺带同步各线路的客户端流量)→ 停用超额 / 到期客户的线路、恢复回到正常的
const check = () =>
  checkAllPanels(db, clientFor)
    .then(() => enforceCustomers(db, clientFor))
    .then((ops) => {
      for (const o of ops) console.log(`${o.action === 'disable' ? '停用' : '启用'} ${o.customer} 在 ${o.panel} 上的 ${o.email}:${o.ok ? '成功' : o.error}`);
    })
    .catch((e) => console.error('同步失败', e));
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
