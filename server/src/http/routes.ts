// /api 路由。

import { Router, type NextFunction, type Request, type Response } from 'express';
import type { DB } from '../db';
import { createClient, type ClientAdmin } from '../clients/create';
import { checkAllPanels, checkPanel, type PanelProbe } from '../panels/check';
import { readPanelDetail, type PanelReader } from '../panels/inbounds';
import { createPanel, deletePanel, getPanel, InputError, listPanels, toPanelView, updatePanel, type Panel } from '../panels/repo';
import { createCustomer, deleteCustomer, getCustomer, getLine, listCustomers, resetSubToken, updateCustomer, deleteLine, zeroLineTraffic, type CustomerView } from '../customers/repo';
import { listSubFetches, subClientCounts } from '../subscription/fetchLog';
import { enforceCustomers } from '../lines/enforce';
import { openLine, removeLine, type LineAdmin } from '../lines/open';
import { checkSocks } from '../socks/check';
import { allSocks, createSocks, deleteSocks, getSocks, getSocksView, listSocks, saveCheck, updateSocks } from '../socks/repo';
import { XUIError } from '../xui/client';
import {
  LoginLimiter,
  passwordMatches,
  readCookie,
  requireAuth,
  SESSION_COOKIE,
  SESSION_MAX_AGE_MS,
  sessionCookie,
  signSession,
  verifySession,
} from './auth';

export interface PanelClient extends ClientAdmin, PanelReader, PanelProbe, LineAdmin {
  deleteClient(email: string): Promise<void>;
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
  sessionSecret: string;
  adminPassword: string;
  clientFor: (panel: Panel) => PanelClient;
  /** 新建 vless 入站后探测端口 */
  probe?: (host: string, port: number) => Promise<boolean>;
  /** 订阅链接地址前缀(SUB_BASE_URL);空 = sub_url 为 null,前端用打开后台的地址拼 */
  subBaseUrl: string;
  /** 订阅拉取记录保留天数 */
  subLogDays: number;
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
  const limiter = new LoginLimiter();
  const r = Router();

  const panelOf = (req: Request): Panel => {
    const panel = getPanel(db, idParam(req));
    if (!panel) throw new InputError('面板不存在');
    return panel;
  };

  r.get('/session', (req, res) => {
    res.json({
      auth_required: authEnabled,
      logged_in: !authEnabled || verifySession(deps.sessionSecret, readCookie(req, SESSION_COOKIE)),
    });
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
    res.setHeader('Set-Cookie', sessionCookie(req, signSession(deps.sessionSecret), SESSION_MAX_AGE_MS));
    res.json({ ok: true });
  });

  r.post('/logout', (req, res) => {
    res.setHeader('Set-Cookie', sessionCookie(req, '', 0));
    res.json({ ok: true });
  });

  r.use(requireAuth(authEnabled, deps.sessionSecret));

  // ---------- 面板 ----------
  r.get('/panels', wrap(() => listPanels(db).map(toPanelView)));
  // 新建后立即检查一次连通性,保存失败的地址 / token 马上能看到
  r.post(
    '/panels',
    wrap(async (req) => {
      const panel = createPanel(db, req.body ?? {});
      return toPanelView(await checkPanel(db, panel, deps.clientFor(panel)));
    }),
  );
  r.patch(
    '/panels/:id',
    wrap(async (req) => {
      const panel = updatePanel(db, idParam(req), req.body ?? {});
      return toPanelView(await checkPanel(db, panel, deps.clientFor(panel)));
    }),
  );
  r.delete('/panels/:id', wrap((req) => void deletePanel(db, idParam(req))));
  r.post('/panels/check', wrap(async () => (await checkAllPanels(db, deps.clientFor)).map(toPanelView)));
  r.post(
    '/panels/:id/check',
    wrap(async (req) => {
      const panel = panelOf(req);
      return toPanelView(await checkPanel(db, panel, deps.clientFor(panel)));
    }),
  );
  // 面板详情:现取入站和 client(只读,不含密钥)
  r.get(
    '/panels/:id/inbounds',
    wrap((req) => {
      const panel = panelOf(req);
      return readPanelDetail(panel, deps.clientFor(panel));
    }),
  );

  // ---------- 版本与升级 ----------
  const withClient = async <T>(panel: Panel, fn: (client: PanelClient) => Promise<T>): Promise<T> => {
    const client = deps.clientFor(panel);
    try {
      return await fn(client);
    } finally {
      await client.close?.().catch(() => {});
    }
  };
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
      return toPanelView(after);
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
      return createClient(panel, deps.clientFor(panel), req.body ?? {}, { otherPanels: listPanels(db), adminFor: deps.clientFor, probe: deps.probe });
    }),
  );
  // 某个 client 的分享链接(现从面板取)
  r.get(
    '/panels/:id/clients/:email/links',
    wrap(async (req) => {
      const client = deps.clientFor(panelOf(req));
      try {
        return { links: await client.clientLinks(String(req.params.email)) };
      } finally {
        await client.close?.().catch(() => {});
      }
    }),
  );
  r.delete(
    '/panels/:id/clients/:email',
    wrap(async (req) => {
      const client = deps.clientFor(panelOf(req));
      try {
        await client.deleteClient(String(req.params.email));
      } finally {
        await client.close?.().catch(() => {});
      }
    }),
  );

  // ---------- 客户与线路 ----------
  // 订阅链接:{SUB_BASE_URL}/sub/<客户的 token>;近几天拉过订阅的客户端数 / IP 数
  const withSub = (customers: CustomerView[]) => {
    const counts = subClientCounts(db, Date.now() - deps.subLogDays * 86_400_000);
    return customers.map((c) => ({ ...c, sub_url: deps.subBaseUrl ? `${deps.subBaseUrl}/sub/${c.sub_token}` : null, sub_clients: counts.get(c.id)?.clients ?? 0, sub_ips: counts.get(c.id)?.ips ?? 0 }));
  };
  const customerOf = (id: number) => {
    const c = getCustomer(db, id);
    if (!c) throw new InputError('客户不存在');
    return withSub([c])[0];
  };
  r.get('/customers', wrap(() => withSub(listCustomers(db))));
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
      const ops = await enforceCustomers(db, deps.clientFor, Date.now(), idParam(req));
      return { ...customerOf(idParam(req)), ops };
    }),
  );
  // 清零已用:把各线路客户端在面板上的流量清零,超额停掉的随之恢复
  r.post(
    '/customers/:id/reset-usage',
    wrap(async (req) => {
      const c = customerOf(idParam(req));
      const failed: { line: string; error: string }[] = [];
      for (const line of c.lines) {
        const panel = getPanel(db, line.panel_id);
        if (!panel) continue;
        try {
          await withClient(panel, (client) => client.resetClientTraffic(line.email));
          zeroLineTraffic(db, line.id);
        } catch (e) {
          failed.push({ line: `${line.panel_name} 上的 ${line.email}`, error: e instanceof Error ? e.message : String(e) });
        }
      }
      const ops = await enforceCustomers(db, deps.clientFor, Date.now(), c.id);
      return { ...customerOf(c.id), failed, ops };
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
  // 删除客户:先删掉他在各面板上的 client,有删不掉的照样删记录,结果里列出来
  r.delete(
    '/customers/:id',
    wrap(async (req) => {
      const c = customerOf(idParam(req));
      const failed: { line: string; error: string }[] = [];
      for (const line of c.lines) {
        try {
          await removeLine(db, line, deps.clientFor);
        } catch (e) {
          failed.push({ line: `${line.panel_name} 上的 ${line.email}`, error: e instanceof Error ? e.message : String(e) });
        }
      }
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
  r.delete(
    '/customers/:id/lines/:lid',
    wrap(async (req) => {
      const line = lineOf(req);
      await removeLine(db, line, deps.clientFor);
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
  r.patch(
    '/socks/:id',
    wrap((req) => {
      updateSocks(db, idParam(req), req.body ?? {});
      return socksOne(idParam(req));
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
      const all = allSocks(db);
      let i = 0;
      await Promise.all(Array.from({ length: Math.min(4, all.length) }, async () => {
        while (i < all.length) {
          const s = all[i++];
          saveCheck(db, s.id, await checkSocks(s));
        }
      }));
      return listSocks(db);
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
