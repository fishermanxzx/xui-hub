// 入口:打开数据库,提供 /api 和前端静态页,定期检查面板连通性。

import express from 'express';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { join, resolve } from 'node:path';
import { applyPendingRestore, backupBuffer, backupName } from './backup';
import { tcpOpen } from './clients/create';
import { listCustomers } from './customers/repo';
import { openDb } from './db';
import { env, isLoopbackHost, PROJECT_ROOT } from './env';
import { apiRouter } from './http/routes';
import { subscriptionRouter } from './http/subscription';
import { subconverterClient } from './subscription/convert';
import { pruneSubFetches } from './subscription/fetchLog';
import { mihomoTemplateMatcher } from './subscription/mihomo';
import { defaultFetcher } from './subscription/service';
import { enforceCustomers } from './lines/enforce';
import { runMonthlyResets } from './lines/reset';
import { alreadyNotified, enforceEvents, markNotified, panelEvents, resetEvent, thresholdEvents } from './notify/events';
import { broadcast, channelsFor, type Message } from './notify/send';
import { checkAllPanels } from './panels/check';
import { listPanels, type Panel } from './panels/repo';
import { getSettings } from './settings';
import { noOverlap } from './util';
import { XUIClient } from './xui/client';

// 数据库含面板 token:新建文件只给当前用户读写
process.umask(0o077);

if (!isLoopbackHost(env.host) && !env.adminPassword) {
  console.error(`监听 ${env.host} 时必须设置 ADMIN_PASSWORD`);
  process.exit(1);
}

// 后台里上传了备份:启动时换上去(旧库留作 hub.db.bak-*)
if (applyPendingRestore(env.dataDir)) console.log('已恢复上传的备份,原数据库改名保留在数据目录');
const db = openDb(join(env.dataDir, 'hub.db'));
const clientFor = (panel: Panel) => new XUIClient(panel, { timeoutMs: 15000 });

const app = express();
app.disable('x-powered-by');
app.set('etag', false);
// 反代经本机 / Docker 内网访问时取真实客户端 IP(登录限流按它计数)
app.set('trust proxy', ['loopback', 'uniquelocal']);
app.use(express.json({ limit: '1mb' }));
// 订阅 /sub/<token>(公开,凭客户各自的 token);Clash / Surge 由内部 subconverter 转换,它带内部密钥回源 /internal/nodes/:id 取节点
const subRouter = subscriptionRouter({
  db,
  fetcher: defaultFetcher({ timeoutMs: 6000 }),
  convert: env.subconverterUrl ? subconverterClient(env.subconverterUrl) : null,
  internalBaseUrl: env.appInternalUrl,
  internalSecret: randomBytes(18).toString('base64url'),
  mihomoTemplate: mihomoTemplateMatcher(env.mihomoTemplate),
  subBaseUrl: env.subBaseUrl,
});
app.use(subRouter);
app.use(
  '/api',
  apiRouter({
    db,
    adminPassword: env.adminPassword,
    clientFor,
    probe: tcpOpen,
    subBaseUrl: env.subBaseUrl,
    subLogDays: env.subLogDays,
    dataDir: env.dataDir,
    // 恢复备份:退出让 systemd / Docker 拉起,起来时换库
    onRestore: () => {
      console.log('恢复备份:重启服务');
      shutdown();
    },
  }),
);

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
// 内部监听:纯 HTTP,只有 /internal/nodes/:id(凭随机密钥),给 subconverter 回源用;主监听是 HTTPS 时它也能连
const internalApp = express();
internalApp.disable('x-powered-by');
internalApp.use((req, res, next) => (req.path.startsWith('/internal/') ? next() : res.status(404).end()));
internalApp.use(subRouter);
const internalServer = createHttpServer(internalApp);
internalServer.listen(env.internalPort, env.internalHost);

/** 发通知;没配渠道就只打日志 */
async function notify(messages: Message[]): Promise<void> {
  if (!messages.length) return;
  const channels = channelsFor(getSettings(db));
  for (const m of messages) {
    console.log(`通知:${m.title}${m.text ? ' — ' + m.text.replace(/\n/g, ' ') : ''}`);
    for (const r of await broadcast(channels, m)) if (!r.ok) console.error(`通知经 ${r.channel} 发送失败:${r.error}`);
  }
}

/** 每天一次把数据库发到 Telegram(开了「每日备份」且配了 Telegram 才做) */
async function dailyBackup(now: number): Promise<void> {
  const s = getSettings(db);
  if (!s.backup.daily || !s.telegram.token || !s.telegram.chat_id) return;
  const key = `backup:${backupName(now).slice(8, 16)}`;
  if (alreadyNotified(db, key)) return;
  const [channel] = channelsFor({ telegram: s.telegram, webhook: { url: '' } });
  try {
    await channel.sendFile!(backupName(now), await backupBuffer(db), `xui-hub 每日备份,${listPanels(db).length} 块面板、${listCustomers(db).length} 位客户`);
    markNotified(db, key, now);
  } catch (e) {
    console.error('每日备份发送失败', e);
  }
}

// 定期:检查各面板(顺带同步各线路的客户端流量)→ 按月清零到期的 → 停用超额 / 到期客户的线路、恢复回到正常的 → 发通知。
// 上一轮没跑完(面板超时)就跳过这一轮
const check = noOverlap(async () => {
  try {
    const now = Date.now();
    const settings = getSettings(db).notify;
    const before = listPanels(db);
    const after = await checkAllPanels(db, clientFor);
    const messages: Message[] = settings.panel_down ? panelEvents(before, after, now) : [];
    for (const r of await runMonthlyResets(db, clientFor, now)) {
      console.log(`按月清零 ${r.customer.name}${r.failed.length ? `,${r.failed.length} 个客户端没清成` : ''}`);
      if (settings.monthly_reset) messages.push(resetEvent(r.customer, r.failed.length, now));
    }
    const ops = await enforceCustomers(db, clientFor);
    for (const o of ops) console.log(`${o.action === 'disable' ? '停用' : '启用'} ${o.customer} 在 ${o.panel} 上的 ${o.email}:${o.ok ? '成功' : o.error}`);
    const customers = listCustomers(db);
    if (settings.customer_disabled) messages.push(...enforceEvents(ops, customers, now));
    messages.push(...thresholdEvents(db, settings, now, customers));
    await notify(messages);
    await dailyBackup(now);
    pruneSubFetches(db, env.subLogDays);
  } catch (e) {
    console.error('同步失败', e);
  }
});
void check();
const timer = setInterval(check, env.checkIntervalSec * 1000);

function shutdown() {
  clearInterval(timer);
  internalServer.close();
  server.close(() => {
    db.close();
    process.exit(0);
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
