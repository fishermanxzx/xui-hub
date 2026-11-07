// /api 路由。

import { Router, type NextFunction, type Request, type Response } from 'express';
import type { DB } from '../db';
import { createClient, type ClientAdmin } from '../clients/create';
import { checkAllPanels, checkPanel, type PanelProbe } from '../panels/check';
import { readPanelDetail, type PanelReader } from '../panels/inbounds';
import { createPanel, deletePanel, getPanel, InputError, listPanels, toPanelView, updatePanel, type Panel } from '../panels/repo';
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

export interface PanelClient extends ClientAdmin, PanelReader, PanelProbe {
  deleteClient(email: string): Promise<void>;
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
      await withClient(panel, (client) => client.installXray(version));
      return toPanelView(await checkPanel(db, panel, deps.clientFor(panel)));
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

  r.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof InputError) return res.status(400).json({ error: err.message });
    // 面板连不上 / 面板 API 报错:不是本服务的问题,也不打堆栈
    if (err instanceof XUIError) return res.status(502).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: err instanceof Error ? err.message : '服务器错误' });
  });

  return r;
}
