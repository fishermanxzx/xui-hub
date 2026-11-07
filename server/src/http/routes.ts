// /api 路由。

import { Router, type NextFunction, type Request, type Response } from 'express';
import type { DB } from '../db';
import {
  addBinding,
  createCustomer,
  customerDailyUsage,
  overallDailyUsage,
  dailyUsageBy,
  deleteCustomer,
  getCustomer,
  listClientRows,
  listCustomers,
  removeBinding,
  updateCustomer,
  type CustomerView,
} from '../customers/repo';
import { openLines, planLines, type PanelLineAdmin } from '../customers/openLines';
import { deleteLines, lineOpForChange, operateLines, type ClientRemover, type LineOpResult, type PanelWriter } from '../customers/panelOps';
import { resetCustomerUsage } from '../customers/monthlyReset';
import { renewedExpiry } from '../customers/renew';
import { exitKey, lineExits, type ExitMap } from '../panels/exits';
import { readPanelDetail, type PanelReader } from '../panels/inbounds';
import { createPanel, getPanel, InputError, listPanels, toPanelView, updatePanel, type Panel } from '../panels/repo';
import { planUninstall, uninstallPanel } from '../panels/uninstall';
import { openDirect, planDirect, type DirectAdmin } from '../customers/directLines';
import { openRelayLines, planRelayLines } from '../customers/relayLines';
import {
  KEEP_LATEST,
  listSnapshots,
  loadSnapshot,
  planRestore,
  readPanelConfig,
  restorePanel,
  takeSnapshot,
  type PanelRestorer,
} from '../panels/snapshots';
import { checkSocks } from '../socks/check';
import { allSocks, createSocks, deleteSocks, getSocks, getSocksView, listSocks, saveCheck, updateSocks } from '../socks/repo';
import { planSocksUninstall, uninstallSocks, uninstallStatus, type SocksPanelEditor } from '../socks/uninstall';
import { readOutboundEndpoint, scanSocksUsage } from '../socks/usage';
import { resetSubToken } from '../customers/repo';
import { listSubFetches, subClientCounts } from '../subscription/fetchLog';
import { collectLinks, linkName, type LinkFetcher } from '../subscription/service';
import { mapLimit, type SyncService } from '../sync/service';
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

export interface RouteDeps {
  db: DB;
  sync: SyncService;
  sessionSecret: string;
  adminPassword: string;
  syncIntervalSec: number;
  tzOffsetMin: number;
  /** 流量历史保留天数:按天查询用量最多查这么多天 */
  historyDays: number;
  /** 订阅拉取记录保留天数 */
  subLogDays: number;
  /** 订阅链接域名(SUB_BASE_URL);空 = 生成不了订阅链接 */
  subBaseUrl: string;
  linkFetcher: LinkFetcher;
  /** 操作面板上的 client(流量清零、启用/停用、清面板限制) */
  panelWriter: (panel: Panel) => PanelWriter;
  /** 读面板的入站、client 和 Xray 配置(面板详情、SOCKS 使用情况) */
  panelReader: (panel: Panel) => PanelReader;
  /** 读面板并新建 client(按出口开通线路) */
  panelAdmin: (panel: Panel) => DirectAdmin;
  /** 读面板配置存快照、按快照恢复面板 */
  panelRestorer: (panel: Panel) => PanelRestorer;
  /** 删除客户时删掉面板上的 client */
  panelRemover: (panel: Panel) => ClientRemover;
  /** 卸载 SOCKS:删面板上的 client、入站,改 Xray 模板并重启 */
  socksRemover: (panel: Panel) => SocksPanelEditor;
  /** 面板配置快照保留天数(每台面板最近几份不论多旧都留) */
  snapshotKeepDays: number;
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

function idParam(req: Request, name = 'id'): number {
  const id = Number(req.params[name]);
  if (!Number.isInteger(id) || id <= 0) throw new InputError(`无效的 ${name}`);
  return id;
}

export function apiRouter(deps: RouteDeps): Router {
  const { db, sync } = deps;
  const authEnabled = deps.adminPassword !== '';
  const limiter = new LoginLimiter();
  const r = Router();

  const panelOf = (req: Request): Panel => {
    const panel = getPanel(db, idParam(req));
    if (!panel) throw new InputError('面板不存在');
    return panel;
  };
  const withPanelRestorer = async <T>(panel: Panel, fn: (client: PanelRestorer) => Promise<T>): Promise<T> => {
    const client = deps.panelRestorer(panel);
    try {
      return await fn(client);
    } finally {
      await client.close?.();
    }
  };
  const withRestorer = <T>(req: Request, fn: (panel: Panel, client: PanelRestorer) => Promise<T>): Promise<T> => {
    const panel = panelOf(req);
    return withPanelRestorer(panel, (client) => fn(panel, client));
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

  // ---------- panels ----------
  r.get('/panels', wrap(() => listPanels(db).map(toPanelView)));
  r.post('/panels', wrap((req) => toPanelView(createPanel(db, req.body ?? {}))));
  r.patch('/panels/:id', wrap((req) => toPanelView(updatePanel(db, idParam(req), req.body ?? {}))));
  // 卸载:预览要删哪些客户线路(不改东西);执行:删面板上的 client(落地机连带中转上出口全经过它的线路)、解绑、移除面板
  r.get('/panels/:id/uninstall-plan', wrap((req) => planUninstall(db, idParam(req))));
  r.post('/panels/:id/uninstall', wrap((req) => uninstallPanel(db, idParam(req), deps.panelRemover)));
  // 中转批量开线路:勾选客户,按各自在用的落地在这台中转上开线路(缺的入站一次建好,只重启一次 Xray)
  r.get('/panels/:id/relay-plan', wrap((req) => planRelayLines(db, panelOf(req).id, deps.panelAdmin)));
  r.post(
    '/panels/:id/relay-lines',
    wrap(async (req) => {
      const panel = panelOf(req);
      const ids = Array.isArray(req.body?.customer_ids) ? req.body.customer_ids.map(Number) : [];
      const out = await openRelayLines(db, panel.id, ids, deps.panelAdmin);
      await withPanelRestorer(panel, (client) => takeSnapshot(db, panel, client)).catch(() => {});
      return out;
    }),
  );
  // 落地机开直连:出口经过它的客户,在落地上直接开 vless 线路(没有可复用的直出 vless 入站就新建)
  r.get('/panels/:id/direct-plan', wrap((req) => planDirect(db, panelOf(req).id, deps.panelAdmin, req.query.protocol)));
  r.post(
    '/panels/:id/direct-lines',
    wrap(async (req) => {
      const panel = panelOf(req);
      const ids = Array.isArray(req.body?.customer_ids) ? req.body.customer_ids.map(Number) : [];
      const out = await openDirect(db, panel.id, ids, deps.panelAdmin, req.body?.protocol);
      await withPanelRestorer(panel, (client) => takeSnapshot(db, panel, client)).catch(() => {});
      return out;
    }),
  );
  // 面板详情:现取入站、去向和 client(只读,不含密钥)
  r.get(
    '/panels/:id/inbounds',
    wrap((req) => {
      const panel = panelOf(req);
      return readPanelDetail(db, panel, deps.panelReader(panel));
    }),
  );
  // 面板配置快照:列表、立即存一份、恢复计划(现读面板对比,不改面板)、按快照恢复
  r.get(
    '/panels/:id/snapshots',
    wrap((req) => ({ keep_days: deps.snapshotKeepDays, keep_latest: KEEP_LATEST, rows: listSnapshots(db, panelOf(req).id) })),
  );
  r.post(
    '/panels/:id/snapshots',
    wrap((req) => withRestorer(req, async (panel, client) => ({ stored: await takeSnapshot(db, panel, client) }))),
  );
  r.get(
    '/panels/:id/snapshots/:sid/plan',
    wrap((req) =>
      withRestorer(req, async (panel, client) => planRestore(loadSnapshot(db, panel.id, idParam(req, 'sid')), await readPanelConfig(client))),
    ),
  );
  r.post(
    '/panels/:id/snapshots/:sid/restore',
    wrap((req) =>
      withRestorer(req, async (panel, client) => ({
        steps: await restorePanel(db, panel, idParam(req, 'sid'), client, { xray: req.body?.xray === true }),
      })),
    ),
  );

  // ---------- sync ----------
  r.get('/sync', wrap(() => ({ busy: sync.busy, interval_sec: deps.syncIntervalSec, last_run: sync.lastRun })));
  r.post('/sync/run', wrap(() => sync.runOnce()));

  // ---------- customers ----------
  // 订阅链接:{SUB_BASE_URL}/sub/<客户的 token>
  const withSubUrl = (customers: CustomerView[]) =>
    customers.map((c) => ({ ...c, sub_url: deps.subBaseUrl ? `${deps.subBaseUrl}/sub/${c.sub_token}` : null }));
  // ---------- socks ----------
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
      const id = idParam(req);
      updateSocks(db, id, req.body ?? {});
      return socksOne(id);
    }),
  );
  r.delete('/socks/:id', wrap((req) => deleteSocks(db, idParam(req))));
  // 卸载:先现读各面板列出会改什么,确认后删各面板上指向它的出站、路由和入站,再从系统移除
  r.get('/socks/:id/uninstall-plan', wrap((req) => planSocksUninstall(db, idParam(req), deps.socksRemover)));
  r.post('/socks/:id/uninstall', wrap((req) => uninstallSocks(db, idParam(req), deps.socksRemover)));
  r.get('/socks/:id/uninstall-status', wrap((req) => uninstallStatus(idParam(req))));
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
  r.get('/socks-usage', wrap(() => scanSocksUsage(db, deps.panelReader)));
  // 把面板上未登记的 SOCKS 出站登记进来(地址和账号从面板配置里取)
  r.post(
    '/socks-adopt',
    wrap(async (req) => {
      const panel = getPanel(db, Number(req.body?.panel_id));
      if (!panel) throw new InputError('面板不存在');
      const ep = await readOutboundEndpoint(deps.panelReader(panel), String(req.body?.outbound_tag ?? ''));
      return socksOne(createSocks(db, { name: req.body?.name, monthly_cost: req.body?.monthly_cost }, Date.now(), ep));
    }),
  );

  const one = (id: number) => {
    const customer = getCustomer(db, id);
    if (!customer) throw new InputError('客户不存在');
    return withSubUrl([customer])[0];
  };

  // 全体客户每日流量(总览图表)
  const daysParam = (req: Request, fallback: number) => Math.min(deps.historyDays, Math.max(1, Number(req.query.days) || fallback));
  // ?exclude=1,2:不算这些面板上的流量
  const excludeParam = (req: Request) =>
    String(req.query.exclude ?? '')
      .split(',')
      .map(Number)
      .filter((n) => Number.isSafeInteger(n) && n > 0)
      .slice(0, 500);
  r.get('/stats/daily', wrap((req) => overallDailyUsage(db, daysParam(req, 30), deps.tzOffsetMin, Date.now(), excludeParam(req))));
  // 每日流量按面板 / 按客户拆开
  r.get('/stats/daily/panels', wrap((req) => dailyUsageBy(db, 'panel', daysParam(req, 30), deps.tzOffsetMin, Date.now(), excludeParam(req))));
  r.get(
    '/stats/daily/customers',
    wrap((req) => dailyUsageBy(db, 'customer', daysParam(req, 30), deps.tzOffsetMin, Date.now(), excludeParam(req))),
  );
  r.get(
    '/customers',
    wrap(async () => {
      // 落地 IP 按配置快照推算;算不出来不影响列表
      const exits = await lineExits(db).catch((e): ExitMap => {
        console.error('[落地 IP]', e);
        return new Map();
      });
      // 近 SUB_LOG_DAYS 天拉订阅用了几个客户端(按 UA 区分)、来自几个 IP
      const fetched = subClientCounts(db, Date.now() - deps.subLogDays * 86_400_000);
      return withSubUrl(listCustomers(db)).map((c) => ({
        ...c,
        sub_clients: fetched.get(c.id)?.clients ?? 0,
        sub_ips: fetched.get(c.id)?.ips ?? 0,
        lines: c.lines.map((l) => ({ ...l, exits: exits.get(exitKey(l.panel_id, l.email)) ?? [] })),
      }));
    }),
  );
  r.post('/customers', wrap((req) => one(createCustomer(db, req.body ?? {}))));
  r.get(
    '/customers/:id',
    wrap((req) => {
      const id = idParam(req);
      return { customer: one(id), daily: customerDailyUsage(db, id, daysParam(req, 14), deps.tzOffsetMin) };
    }),
  );
  // 预览客户订阅里的节点(现取,只返回节点名,不返回含密钥的完整链接)
  r.get(
    '/customers/:id/sub-preview',
    wrap(async (req) => {
      const id = idParam(req);
      one(id);
      const lines = await collectLinks(db, id, deps.linkFetcher);
      return lines.map(({ links, ...line }) => ({ ...line, nodes: links.map((l) => ({ protocol: l.slice(0, l.indexOf('://')), name: linkName(l) })) }));
    }),
  );
  r.patch(
    '/customers/:id',
    wrap(async (req) => {
      const id = idParam(req);
      const before = one(id);
      updateCustomer(db, id, req.body ?? {});
      const after = one(id);
      // 进出"正常"时启停面板上的线路(到期、额度只在本系统判断,不写到面板)
      const op = lineOpForChange(before, after);
      if (!op) return after;
      const panel_ops = await operateLines(db, id, op, deps.panelWriter);
      return { ...one(id), panel_ops };
    }),
  );
  // 删除客户:先删掉他在各面板上的 client,有删不掉的就不删客户(已删的下次算成功,可以重试);
  // 都删了再删客户和线路绑定(订阅链接随之失效)
  r.delete(
    '/customers/:id',
    wrap(async (req) => {
      const id = idParam(req);
      one(id);
      const lines = await deleteLines(db, id, deps.panelRemover);
      const failed = lines.filter((l) => !l.ok);
      if (failed.length) {
        throw new InputError(
          `客户没有删除:${failed.map((l) => `${l.panel} 上的 ${l.email}(${l.error})`).join('、')} 删除失败。面板恢复后再删,或先把这条线路解绑`,
        );
      }
      deleteCustomer(db, id);
      return { lines };
    }),
  );
  // 重置订阅链接:换一个 token,客户手里的旧链接立即失效
  r.post(
    '/customers/:id/sub-token',
    wrap((req) => {
      const id = idParam(req);
      resetSubToken(db, id);
      return one(id);
    }),
  );
  r.post(
    '/customers/:id/reset-usage',
    wrap(async (req) => {
      const id = idParam(req);
      one(id);
      // 面板上的启用状态 operateLines 已记到本地,不用再等一轮同步
      const lines = await resetCustomerUsage(db, id, deps.panelWriter);
      return { customer: one(id), lines };
    }),
  );
  // 续费:顺延到期日(已到期从今天算),可选同时清零已用;客户因此恢复正常时启用线路
  r.post(
    '/customers/:id/renew',
    wrap(async (req) => {
      const id = idParam(req);
      const before = one(id);
      updateCustomer(db, id, { expire_at: renewedExpiry(before.expire_at, Number(req.body?.months), Date.now(), deps.tzOffsetMin) });
      let lines: LineOpResult[] = [];
      if (req.body?.reset_usage === true) {
        lines = await resetCustomerUsage(db, id, deps.panelWriter);
      } else {
        const op = lineOpForChange(before, one(id));
        if (op) lines = await operateLines(db, id, op, deps.panelWriter);
      }
      return { customer: one(id), lines };
    }),
  );
  // 按出口开通线路:先看计划(各中转上通往各出口的入站、客户已有的线路),再在选中的中转上开
  r.get(
    '/customers/:id/sub-fetches',
    wrap((req) => {
      const id = idParam(req);
      one(id);
      return { days: deps.subLogDays, rows: listSubFetches(db, id) };
    }),
  );
  r.get('/customers/:id/line-plan', wrap((req) => planLines(db, idParam(req), deps.panelAdmin)));
  r.post(
    '/customers/:id/open-lines',
    wrap(async (req) => {
      const id = idParam(req);
      const { exit, panel_ids } = req.body ?? {};
      if (typeof exit !== 'string' || !Array.isArray(panel_ids) || !panel_ids.length) throw new InputError('缺少出口或中转');
      const results = await openLines(db, id, exit, panel_ids.map(Number), deps.panelAdmin);
      // 新 client 补进配置快照,落地 IP 马上算得出来
      const touched = new Set(results.filter((r) => r.ok).map((r) => r.panel));
      for (const panel of listPanels(db).filter((p) => touched.has(p.name))) {
        await withPanelRestorer(panel, (client) => takeSnapshot(db, panel, client)).catch(() => {});
      }
      return { customer: one(id), results };
    }),
  );
  r.post(
    '/customers/:id/bindings',
    wrap((req) => {
      const id = idParam(req);
      const { panel_id, email, include_current_usage } = req.body ?? {};
      if (!email) throw new InputError('缺少 email');
      addBinding(db, id, Number(panel_id), String(email), include_current_usage === true);
      return one(id);
    }),
  );
  r.delete(
    '/customers/:id/bindings/:bindingId',
    wrap((req) => {
      const id = idParam(req);
      removeBinding(db, id, idParam(req, 'bindingId'));
      return one(id);
    }),
  );

  r.get('/clients', wrap((req) => listClientRows(db, { unboundOnly: req.query.unbound === '1' })));

  r.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof InputError) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  });

  return r;
}
