// /api 路由。

import { Router, raw, type NextFunction, type Request, type Response } from 'express';
import { backupBuffer, backupName, inspectBackup, stageRestore } from '../backup';
import type { DB } from '../db';
import { createClient, type ClientAdmin } from '../clients/create';
import { checkAllPanels, checkPanel, type PanelProbe } from '../panels/check';
import { readPanelDetail, type PanelReader } from '../panels/inbounds';
import { createPanel, deletePanel, getPanel, InputError, listPanels, toPanelView, updatePanel, type Panel } from '../panels/repo';
import {
  createCustomer,
  deleteCustomer,
  deleteLine,
  getCustomer,
  getLine,
  lineByEmail,
  linesOnPanel,
  listCustomers,
  resetSubToken,
  updateCustomer,
  type CustomerView,
  type Line,
} from '../customers/repo';
import { importClients } from '../lines/import';
import { resetCustomerUsage } from '../lines/reset';
import { broadcast, channelsFor } from '../notify/send';
import { getSettings, updateSettings } from '../settings';
import { DEFAULT_TEMPLATE, TEMPLATES } from '../subscription/templates';
import { listSubFetches, subClientCounts } from '../subscription/fetchLog';
import { enforceCustomers } from '../lines/enforce';
import { openLine, removeLine, removeLines, repointSocksLines, type LineAdmin } from '../lines/open';
import { checkSocks } from '../socks/check';
import { allSocks, createSocks, deleteSocks, getSocks, getSocksView, listSocks, planSocksUpdate, saveCheck, updateSocks } from '../socks/repo';
import { errorText, mapLimit, panelKey, serial, using } from '../util';
import { XUIError } from '../xui/client';
import { LoginLimiter, passwordMatches, readCookie, requireAuth, SESSION_COOKIE, SESSION_MAX_AGE_MS, sessionCookie, sessionKeys, signSession, verifySession } from './auth';

export interface PanelClient extends ClientAdmin, PanelReader, PanelProbe, LineAdmin {
  setClientsEnabled(emails: string[], enable: boolean): Promise<void>;
  resetClientTraffic(email: string): Promise<void>;
  serverStatus(): Promise<{ panelVersion: string; xrayVersion: string; xrayState: string; xrayError: string }>;
  xrayVersions(): Promise<string[]>;
  panelUpdateInfo(): Promise<{ channel: string; current: string; latest: string; available: boolean } | null>;
  installXray(version: string): Promise<void>;
  updatePanel(): Promise<string>;
  updateStatus(): Promise<{ runId: string; state: string; exitCode: number }>;
}

export interface RouteDeps {
  db: DB;
  adminPassword: string;
  clientFor: (panel: Panel) => PanelClient;
  /** 新建 vless 入站后探测端口 */
  probe?: (host: string, port: number) => Promise<boolean>;
  /** 订阅链接地址前缀(SUB_BASE_URL);空 = sub_url 为 null,前端用打开后台的地址拼 */
  subBaseUrl: string;
  /** 订阅拉取记录保留天数 */
  subLogDays: number;
  /** 数据目录(恢复备份时把文件放这里) */
  dataDir?: string;
  /** 恢复文件放好后调用:退出进程让 systemd / Docker 重启 */
  onRestore?: () => void;
}

type Handler = (req: Request, res: Response) => unknown;

function wrap(fn: Handler) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await fn(req, res);
      if (!res.headersSent) res.json(result ?? { ok: true });
    } catch (e) {
      next(e);
    }
  };
}

function idParam(req: Request): number {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw new InputError('无效的 id');
  return id;
}

export function apiRouter(deps: RouteDeps): Router {
  const { db } = deps;
  const authEnabled = deps.adminPassword !== '';
  const keys = sessionKeys(db, deps.adminPassword);
  const limiter = new LoginLimiter();
  const r = Router();
  const loggedIn = (req: Request) => !authEnabled || verifySession(keys.current(), readCookie(req, SESSION_COOKIE));
  const withClient = <T>(panel: Panel, fn: (client: PanelClient) => Promise<T>): Promise<T> => using(deps.clientFor(panel), fn);
  const view = (panel: Panel) => toPanelView(db, panel);
  const lineLabel = (line: Line) => `${line.panel_name} 上的 ${line.email}`;

  const panelOf = (req: Request): Panel => {
    const panel = getPanel(db, idParam(req));
    if (!panel) throw new InputError('面板不存在');
    return panel;
  };

  r.get('/session', (req, res) => {
    res.json({ auth_required: authEnabled, logged_in: loggedIn(req) });
  });

  r.post('/login', (req, res) => {
    const ip = req.ip ?? 'unknown';
    if (!authEnabled) return res.json({ ok: true });
    if (!limiter.allow(ip)) return res.status(429).json({ error: '尝试次数过多,请 10 分钟后再试' });
    if (!passwordMatches(deps.adminPassword, req.body?.password)) {
      limiter.fail(ip);
      return res.status(401).json({ error: '密码错误' });
    }
    limiter.clear(ip);
    res.setHeader('Set-Cookie', sessionCookie(req, signSession(keys.current()), SESSION_MAX_AGE_MS));
    res.json({ ok: true });
  });

  // 退出登录换掉签名密钥:这台和其他设备上的会话一起失效(拿着旧 cookie 的也进不来)
  r.post('/logout', (req, res) => {
    if (authEnabled && loggedIn(req)) keys.rotate();
    res.setHeader('Set-Cookie', sessionCookie(req, '', 0));
    res.json({ ok: true });
  });

  r.use(requireAuth(authEnabled, keys.current));

  // ---------- 面板 ----------
  r.get('/panels', wrap(() => listPanels(db).map(view)));
  // 新建后立即检查一次连通性,保存失败的地址 / token 马上能看到
  r.post(
    '/panels',
    wrap(async (req) => {
      const panel = createPanel(db, req.body ?? {});
      return view(await checkPanel(db, panel, deps.clientFor(panel)));
    }),
  );
  r.patch(
    '/panels/:id',
    wrap(async (req) => {
      const panel = updatePanel(db, idParam(req), req.body ?? {});
      return view(await checkPanel(db, panel, deps.clientFor(panel)));
    }),
  );
  // 面板上还有客户线路时要带 ?force=1(线路记录会跟着删掉)
  r.delete('/panels/:id', wrap((req) => void deletePanel(db, idParam(req), req.query.force === '1')));
  r.post('/panels/check', wrap(async () => (await checkAllPanels(db, deps.clientFor)).map(view)));
  r.post(
    '/panels/:id/check',
    wrap(async (req) => {
      const panel = panelOf(req);
      return view(await checkPanel(db, panel, deps.clientFor(panel)));
    }),
  );
  // 面板详情:现取入站和 client(只读,不含密钥);每个 client 标上它是哪位客户的线路
  r.get(
    '/panels/:id/inbounds',
    wrap(async (req) => {
      const panel = panelOf(req);
      const detail = await readPanelDetail(panel, deps.clientFor(panel));
      const owners = new Map(linesOnPanel(db, panel.id).map((l) => [l.email, l.customer_id]));
      const names = new Map(listCustomers(db).map((c) => [c.id, c.name]));
      const tag = (c: { email: string }) => {
        const id = owners.get(c.email);
        return { ...c, customer: id == null ? null : { id, name: names.get(id) ?? '?' } };
      };
      return { ...detail, inbounds: detail.inbounds.map((ib) => ({ ...ib, clients: ib.clients.map(tag) })), unattached: detail.unattached.map(tag) };
    }),
  );

  // ---------- 版本与升级 ----------
  // 面板版本、可升级信息、Xray 当前版本与可选版本(现从面板取)
  r.get(
    '/panels/:id/versions',
    wrap((req) =>
      withClient(panelOf(req), async (client) => {
        const [status, update, versions] = await Promise.all([client.serverStatus(), client.panelUpdateInfo(), client.xrayVersions().catch(() => [] as string[])]);
        return {
          panel: { current: status.panelVersion, latest: update?.latest ?? null, update_available: update?.available ?? false, channel: update?.channel ?? null },
          xray: { current: status.xrayVersion, state: status.xrayState, error: status.xrayError, available: versions },
        };
      }),
    ),
  );
  // 切换 Xray 内核版本:面板下载对应版本并重启 Xray(上面所有客户端断流几秒)
  r.post(
    '/panels/:id/xray/:version',
    wrap(async (req) => {
      const panel = panelOf(req);
      const version = String(req.params.version);
      if (!/^v?\d+\.\d+\.\d+$/.test(version)) throw new InputError('版本号不合法');
      await withClient(panel, async (client) => {
        await client.installXray(version);
        // 面板下载并重启 Xray 要几秒到几十秒,等它回到 running(最多 90 秒)再记录版本
        for (let i = 0; i < 45; i++) {
          await new Promise((r) => setTimeout(r, 2000));
          const st = await client.serverStatus().catch(() => null);
          if (st?.xrayState === 'running' && st.xrayVersion === version.replace(/^v/, '')) return;
        }
      });
      const after = await checkPanel(db, panel, deps.clientFor(panel));
      if (after.xray_state !== 'running') throw new InputError(`Xray 没有回到运行状态(${after.xray_state ?? '未知'}),去面板上看日志`);
      if (after.xray_version !== version.replace(/^v/, '')) throw new InputError(`Xray 仍是 ${after.xray_version},切换没有生效`);
      return view(after);
    }),
  );
  // 升级面板:面板自己在后台跑升级脚本,这里拿到 runId;前端轮询 update-status
  r.post(
    '/panels/:id/update',
    wrap((req) => withClient(panelOf(req), async (client) => ({ run_id: await client.updatePanel() }))),
  );
  r.get(
    '/panels/:id/update-status',
    wrap(async (req) => {
      const panel = panelOf(req);
      const status = await withClient(panel, (client) => client.updateStatus());
      // 升级成功后面板版本变了,顺手刷新记录
      if (status.state === 'success') await checkPanel(db, panel, deps.clientFor(panel));
      return status;
    }),
  );

  // ---------- 客户端 ----------
  r.post(
    '/panels/:id/clients',
    wrap((req) => {
      const panel = panelOf(req);
      return serial(panelKey(panel.id), () =>
        createClient(panel, deps.clientFor(panel), req.body ?? {}, {
          otherPanels: listPanels(db),
          adminFor: deps.clientFor,
          probe: deps.probe,
          taken: linesOnPanel(db, panel.id).map((l) => l.email),
        }),
      );
    }),
  );
  // 某个 client 的分享链接(现从面板取)
  r.get(
    '/panels/:id/clients/:email/links',
    wrap((req) => withClient(panelOf(req), async (client) => ({ links: await client.clientLinks(String(req.params.email)) }))),
  );
  // 删 client;它要是某位客户的线路,出口规则和线路记录一起删,不留下对不上的记录
  r.delete(
    '/panels/:id/clients/:email',
    wrap(async (req) => {
      const panel = panelOf(req);
      const email = String(req.params.email);
      const line = lineByEmail(db, panel.id, email);
      if (line) {
        await removeLine(db, line, deps.clientFor);
        deleteLine(db, line.id);
      } else {
        await serial(panelKey(panel.id), () => withClient(panel, (client) => client.deleteClient(email)));
      }
      return { ok: true, line_removed: !!line };
    }),
  );

  // ---------- 客户与线路 ----------
  // 订阅链接:{SUB_BASE_URL}/sub/<客户的 token>;近几天拉过订阅的客户端数 / IP 数
  const withSub = (customers: CustomerView[]) => {
    const counts = subClientCounts(db, Date.now() - deps.subLogDays * 86_400_000);
    return customers.map((c) => ({ ...c, sub_url: deps.subBaseUrl ? `${deps.subBaseUrl}/sub/${c.sub_token}` : null, sub_clients: counts.get(c.id)?.clients ?? 0, sub_ips: counts.get(c.id)?.ips ?? 0 }));
  };
  const plainCustomer = (id: number) => {
    const c = getCustomer(db, id);
    if (!c) throw new InputError('客户不存在');
    return c;
  };
  const customerOf = (id: number) => withSub([plainCustomer(id)])[0];
  r.get('/customers', wrap(() => withSub(listCustomers(db))));
  // 可选的 Clash 订阅模板(内置的);客户也可以填自定义地址
  r.get('/sub-templates', wrap(() => ({ default: DEFAULT_TEMPLATE, templates: TEMPLATES.map(({ id, name, desc }) => ({ id, name, desc })) })));
  // 重置订阅链接:换一个 token,客户手里的旧链接立即失效
  r.post(
    '/customers/:id/sub-token',
    wrap((req) => {
      resetSubToken(db, idParam(req));
      return customerOf(idParam(req));
    }),
  );
  r.get('/customers/:id/sub-fetches', wrap((req) => ({ days: deps.subLogDays, rows: listSubFetches(db, customerOf(idParam(req)).id) })));
  r.post('/customers', wrap((req) => customerOf(createCustomer(db, req.body ?? {}))));
  // 改了额度 / 到期马上执行一次停用 / 恢复,不等下一轮同步
  r.patch(
    '/customers/:id',
    wrap(async (req) => {
      updateCustomer(db, idParam(req), req.body ?? {});
      const ops = await enforceCustomers(db, deps.clientFor, idParam(req));
      return { ...customerOf(idParam(req)), ops };
    }),
  );
  // 清零已用:把各线路客户端在面板上的流量清零,超额停掉的随之恢复
  r.post(
    '/customers/:id/reset-usage',
    wrap(async (req) => {
      const c = plainCustomer(idParam(req));
      const failed = await resetCustomerUsage(db, c, deps.clientFor);
      const ops = await enforceCustomers(db, deps.clientFor, c.id);
      return { ...customerOf(c.id), failed, ops };
    }),
  );
  // 把面板上已有的客户端归到这位客户名下(成为直连线路),面板上不改任何东西
  r.post(
    '/customers/:id/lines/import',
    wrap(async (req) => {
      const r = await importClients(db, idParam(req), req.body ?? {}, deps.clientFor);
      return { ...r, customer: customerOf(idParam(req)) };
    }),
  );
  // 立即同步全部面板并执行额度 / 到期
  r.post(
    '/sync',
    wrap(async () => {
      await checkAllPanels(db, deps.clientFor);
      return { ops: await enforceCustomers(db, deps.clientFor) };
    }),
  );
  // 删除客户:先删掉他在各面板上的 client 和出口规则(每块面板只连一次),有删不掉的照样删记录,结果里列出来
  r.delete(
    '/customers/:id',
    wrap(async (req) => {
      const c = plainCustomer(idParam(req));
      const failed = (await removeLines(db, c.lines, deps.clientFor)).map(({ line, error }) => ({ line: lineLabel(line), error: errorText(error) }));
      deleteCustomer(db, c.id);
      return { failed };
    }),
  );
  // 开线路:直连 / 中转(见 lines/open.ts)
  r.post('/customers/:id/lines', wrap((req) => openLine(db, idParam(req), req.body ?? {}, deps.clientFor, deps.probe)));
  const lineOf = (req: Request) => {
    const line = getLine(db, Number(req.params.lid));
    if (!line || line.customer_id !== idParam(req)) throw new InputError('线路不存在');
    return line;
  };
  r.get(
    '/customers/:id/lines/:lid/links',
    wrap(async (req) => {
      const line = lineOf(req);
      const panel = getPanel(db, line.panel_id);
      if (!panel) throw new InputError('线路所在的面板已删除');
      return withClient(panel, async (client) => ({ links: await client.clientLinks(line.email) }));
    }),
  );
  // 面板连不上 / 已经报废时删不掉面板上的 client,带 ?force=1 就只删这条记录
  r.delete(
    '/customers/:id/lines/:lid',
    wrap(async (req) => {
      const line = lineOf(req);
      await removeLine(db, line, deps.clientFor).catch((e) => {
        if (req.query.force !== '1') throw e;
      });
      deleteLine(db, line.id);
    }),
  );

  // ---------- SOCKS ----------
  const socksOne = (id: number) => {
    const view = getSocksView(db, id);
    if (!view) throw new InputError('SOCKS 不存在');
    return view;
  };
  r.get('/socks', wrap(() => listSocks(db)));
  r.post('/socks', wrap((req) => socksOne(createSocks(db, req.body ?? {}))));
  // 换了地址 / 账号:先把在用它的中转改指到新地址,都改成了才保存
  r.patch(
    '/socks/:id',
    wrap(async (req) => {
      const id = idParam(req);
      const { endpoint } = planSocksUpdate(db, id, req.body ?? {});
      if (endpoint) await repointSocksLines(db, id, endpoint, deps.clientFor);
      updateSocks(db, id, req.body ?? {});
      return socksOne(id);
    }),
  );
  r.delete('/socks/:id', wrap((req) => void deleteSocks(db, idParam(req))));
  // 连通性测试:从本服务所在机器经代理访问 Cloudflare,拿到出口 IP 和地区
  r.post(
    '/socks/:id/check',
    wrap(async (req) => {
      const s = getSocks(db, idParam(req));
      if (!s) throw new InputError('SOCKS 不存在');
      saveCheck(db, s.id, await checkSocks(s));
      return socksOne(s.id);
    }),
  );
  r.post(
    '/socks-check-all',
    wrap(async () => {
      await mapLimit(allSocks(db), 4, async (s) => saveCheck(db, s.id, await checkSocks(s)));
      return listSocks(db);
    }),
  );

  // ---------- 设置:通知渠道、提醒项、备份 ----------
  r.get('/settings', wrap(() => getSettings(db)));
  r.patch('/settings', wrap((req) => updateSettings(db, req.body ?? {})));
  // 用保存好的渠道发一条测试消息
  r.post(
    '/settings/test',
    wrap(async () => {
      const channels = channelsFor(getSettings(db));
      if (!channels.length) throw new InputError('还没配置任何通知渠道');
      return { results: await broadcast(channels, { event: 'test', title: 'xui-hub 测试通知', text: '收到这条说明通知渠道配置正确。', at: Date.now() }) };
    }),
  );

  // ---------- 备份 / 恢复 ----------
  r.get(
    '/backup',
    wrap(async (_req, res) => {
      const data = await backupBuffer(db);
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${backupName()}"`);
      res.send(data);
    }),
  );
  // 上传一份 hub.db 整个换掉:先核对是 xui-hub 的库,放到待恢复位置,响应后退出进程,重启时换上去
  r.post(
    '/restore',
    raw({ type: () => true, limit: '256mb' }),
    wrap((req, res) => {
      if (!deps.dataDir) throw new InputError('这个部署不支持在线恢复');
      const data = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const info = inspectBackup(data);
      stageRestore(deps.dataDir, data);
      res.json({ ...info, restarting: !!deps.onRestore });
      if (deps.onRestore) setTimeout(deps.onRestore, 500);
    }),
  );

  r.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof InputError) return res.status(400).json({ error: err.message });
    // 面板连不上 / 面板 API 报错:不是本服务的问题,也不打堆栈
    if (err instanceof XUIError) return res.status(502).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: err instanceof Error ? err.message : '服务器错误' });
  });

  return r;
}
