// 入口:打开数据库,启动流量同步,提供 /api 和前端静态页。

import express from 'express';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { startDailyBackup } from './backups';
import { enforceCustomers } from './customers/enforce';
import { autoResetCustomers } from './customers/monthlyReset';
import { openDb } from './db';
import { env, isLoopbackHost, PROJECT_ROOT } from './env';
import { loadSessionSecret } from './http/auth';
import { apiRouter } from './http/routes';
import { subdomainGuard } from './http/subdomainGuard';
import { subscriptionRouter } from './http/subscription';
import type { Panel } from './panels/repo';
import { startPanelSnapshots } from './panels/snapshots';
import { subconverterClient } from './subscription/convert';
import { pruneSubFetches } from './subscription/fetchLog';
import { mihomoTemplateMatcher } from './subscription/mihomo';
import { defaultFetcher } from './subscription/service';
import { pruneHistory } from './sync/retention';
import { SyncService } from './sync/service';
import { XUIClient } from './xui/client';

// 数据库含面板 token:新建文件只给当前用户读写
process.umask(0o077);

if (!isLoopbackHost(env.host) && !env.adminPassword) {
  console.error(`监听 ${env.host} 时必须设置 ADMIN_PASSWORD`);
  process.exit(1);
}

const db = openDb(join(env.dataDir, 'hub.db'));
// 操作面板(已用清零、启用/停用、清面板限制、按快照恢复)、读面板入站和 Xray 配置(面板详情、SOCKS 使用情况、配置快照)
const panelClient = (panel: Panel) => new XUIClient(panel, { timeoutMs: 15000 });
const sync = new SyncService(db, {
  intervalSec: env.syncIntervalSec,
  concurrency: env.syncConcurrency,
  // 先做每月按到期日的自动清零(超额的因此恢复),再把超额、到期、停用客户还启用着的线路停掉;
  // 最后删掉超过保留天数的流量历史和订阅拉取记录
  afterRun: async () => {
    await autoResetCustomers(db, panelClient, env.tzOffsetMin);
    await enforceCustomers(db, panelClient);
    pruneHistory(db, env.historyDays);
    pruneSubFetches(db, env.subLogDays);
  },
});
const linkFetcher = defaultFetcher({ timeoutMs: 6000 });

const app = express();
app.disable('x-powered-by');
app.set('etag', false);
// 反代(同机 Caddy 容器或宿主机进程)经 Docker 内网访问;端口只绑本机,私网来源即可信,
// 从而拿到真实客户端 IP(登录限流按它计数)和 https 协议(cookie 加 Secure)
app.set('trust proxy', ['loopback', 'uniquelocal']);
app.use(express.json({ limit: '2mb' }));
// 订阅域名只提供订阅,后台域名不提供订阅(经隧道回源时不经过 Caddy)
app.use(subdomainGuard(env.subDomains));

// 订阅 /sub/<token>(公开,凭客户各自的 token)
app.use(
  subscriptionRouter({
    db,
    fetcher: linkFetcher,
    convert: env.subconverterUrl ? subconverterClient(env.subconverterUrl) : null,
    internalBaseUrl: env.appInternalUrl,
    internalSecret: randomBytes(18).toString('base64url'),
    mihomoTemplate: mihomoTemplateMatcher(env.mihomoTemplate),
  }),
);
app.use(
  '/api',
  apiRouter({
    db,
    sync,
    sessionSecret: loadSessionSecret(db),
    adminPassword: env.adminPassword,
    syncIntervalSec: env.syncIntervalSec,
    tzOffsetMin: env.tzOffsetMin,
    historyDays: env.historyDays,
    subLogDays: env.subLogDays,
    subBaseUrl: env.subBaseUrl,
    linkFetcher,
    panelWriter: panelClient,
    panelReader: panelClient,
    panelAdmin: panelClient,
    panelRestorer: panelClient,
    panelRemover: panelClient,
    socksRemover: panelClient,
    snapshotKeepDays: env.backupKeepDays,
  }),
);

const dist = resolve(PROJECT_ROOT, 'web/dist');
if (existsSync(dist)) {
  app.use(express.static(dist));
  app.get('*', (_req, res) => res.sendFile(join(dist, 'index.html')));
}

const server = app.listen(env.port, env.host, () => {
  console.log(`xui-hub listening on http://${env.host}:${env.port}` + (env.adminPassword ? '' : '(未设置 ADMIN_PASSWORD,不鉴权)'));
  sync.start();
});
const stopBackup = startDailyBackup(db, join(env.dataDir, 'backups'), env.backupKeepDays, env.offsite);
const stopSnapshots = startPanelSnapshots(db, panelClient, env.backupKeepDays);

function shutdown() {
  sync.stop();
  stopBackup();
  stopSnapshots();
  server.close(() => {
    db.close();
    process.exit(0);
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
