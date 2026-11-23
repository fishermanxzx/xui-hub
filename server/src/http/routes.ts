// /api 路由。

import { Router, raw, type NextFunction, type Request, type Response } from 'express';
import { backupBuffer, backupName, inspectBackup, stageRestore } from '../backup';
import { downloadBackup, errorText as s3Error, listRemote, remoteEnabled, remoteStatus, runRemoteBackup } from '../remoteBackup';
import type { DB } from '../db';
import { createClient, type ClientAdmin } from '../clients/create';
import { checkAllPanels, checkPanel, type PanelProbe } from '../panels/check';
import { readPanelDetail, type PanelReader } from '../panels/inbounds';
import { createPanel, deletePanel, getPanel, InputError, listPanels, toPanelView, updatePanel, validRatio, type Panel } from '../panels/repo';
import {
  adjustUsage,
  previewPanelRatio,
  createCustomer,
  deleteCustomer,
  deleteLine,
  getCustomer,
  clearLineNames,
  getLine,
  lineByEmail,
  lineNodeName,
  linesOnPanel,
  listCustomers,
  resetSubToken,
  setLineName,
  updateCustomer,
  type CustomerView,
  type Line,
} from '../customers/repo';
import { deletePayment, insertPayment, lastPayments, listPayments, renewedExpire, renewSpan, validAmount, validNote, validPaidAt } from '../customers/payments';
import { importClients } from '../lines/import';
import { resetCustomerUsage } from '../lines/reset';
import { broadcast, channelsFor } from '../notify/send';
import { getSettings, updateSettings } from '../settings';
import { checkCustomTemplate, DEFAULT_TEMPLATE, isCustomTemplate, TEMPLATES, validTemplate, type TemplateFetcher } from '../subscription/templates';
import { listSubFetches, subClientCounts, subIpsSince } from '../subscription/fetchLog';
import { deleteDevice, deviceCounts, listDevices } from '../subscription/devices';
import { renameLinks, validNodeName } from '../subscription/nodeName';
import { fetchUpstream, refreshUpstreams, type UpstreamFetcher } from '../subscription/upstream';
import { createToken, deleteToken, listTokens, TOKEN_BLOCKED, tokenName, verifyToken } from './tokens';
import { listGrants, revokeGrant } from '../mcp/oauth';
import { enforceCustomers } from '../lines/enforce';
import { applyLineRules, changeLineExits, openLine, parseExitTarget, removeLine, removeLines, repointSocksLines, type LineAdmin } from '../lines/open';
import { validRules } from '../lines/rules';
import { checkSocks } from '../socks/check';
import { allSocks, createSocks, deleteSocks, getSocks, getSocksView, listSocks, planSocksUpdate, saveCheck, updateSocks } from '../socks/repo';
import { trafficReport } from '../traffic/daily';
import { ACTOR_HEADER, addOpLog, decodeActor, listOpLog } from '../oplog/log';
import { describe as describeOp, MUTATING, snapshot } from '../oplog/describe';
import { replayGuard } from './replay';
import { clientIp } from '../subscription/fetchLog';
import type { Updater } from '../update';
import { errorText, mapLimit, panelKey, serial, using } from '../util';
import { XUIError, type GeoCategory, type GeoEntry, type GeoFile, type GeoIssue, type GeoKind, type GeoPage } from '../xui/client';
import { isGeoUnsupported, validateTokens } from '../lines/geodata';
import { LoginLimiter, passwordMatches, readCookie, SESSION_COOKIE, SESSION_MAX_AGE_MS, sessionCookie, sessionKeys, signSession, verifySession } from './auth';

export interface PanelClient extends ClientAdmin, PanelReader, PanelProbe, LineAdmin {
  geodataFiles(): Promise<GeoFile[]>;
  geodataCategories(file: string): Promise<GeoCategory[]>;
  geodataEntries(file: string, code: string, q: string, offset: number, limit: number): Promise<GeoPage<GeoEntry>>;
  geodataValidate(kind: GeoKind, tokens: string[]): Promise<GeoIssue[]>;
  setClientsEnabled(emails: string[], enable: boolean): Promise<void>;
  resetClientTraffic(email: string): Promise<void>;
  serverStatus(): Promise<{ panelVersion: string; xrayVersion: string; xrayState: string; xrayError: string }>;
  xraySettings(): Promise<unknown>;
  xrayVersions(): Promise<string[]>;
  panelUpdateInfo(): Promise<{ channel: string; current: string; latest: string; available: boolean } | null>;
  installXray(version: string): Promise<void>;
  restartPanel(): Promise<void>;
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
  /** xui-hub 自己的版本检查和更新;不给 = 没有这两个接口 */
  updater?: Updater;
  /** 拉自定义订阅模板(保存前校验用);测试里换成假的 */
  fetchTemplate?: TemplateFetcher;
  /** 拉外部订阅;测试里换成假的 */
  fetchUpstream?: UpstreamFetcher;
  /** 内部通道(MCP 工具调的):认请求头里带来的「谁、从哪个 IP」,记操作日志用 */
  trustActorHeader?: boolean;
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

  /** 登录 / 退出也记进操作日志(没设后台密码时没有登录这回事,不记) */
  const logSession = (req: Request, summary: string, ok: boolean, error = '') =>
    addOpLog(db, { at: Date.now(), actor: '后台', ip: clientIp(req), action: `POST ${req.path}`, summary, ok, error, customer_id: null });
  r.post('/login', (req, res) => {
    const ip = req.ip ?? 'unknown';
    if (!authEnabled) return res.json({ ok: true });
    if (!limiter.allow(ip)) return res.status(429).json({ error: '尝试次数过多,请 10 分钟后再试' });
    if (!passwordMatches(deps.adminPassword, req.body?.password)) {
      limiter.fail(ip);
      logSession(req, '登录', false, '密码错误');
      return res.status(401).json({ error: '密码错误' });
    }
    limiter.clear(ip);
    logSession(req, '登录', true);
    res.setHeader('Set-Cookie', sessionCookie(req, signSession(keys.current()), SESSION_MAX_AGE_MS));
    res.json({ ok: true });
  });

  // 退出登录换掉签名密钥:这台和其他设备上的会话一起失效(拿着旧 cookie 的也进不来)
  r.post('/logout', (req, res) => {
    if (authEnabled && loggedIn(req)) {
      keys.rotate();
      logSession(req, '退出登录(所有设备上的登录一起失效)', true);
    }
    res.setHeader('Set-Cookie', sessionCookie(req, '', 0));
    res.json({ ok: true });
  });

  // 登录的会话,或开放 API 的令牌(Authorization: Bearer xh_…)。令牌碰不了设置、备份恢复和令牌管理;带错令牌和输错密码一样计入限流
  // res.locals.actor / ip:这次请求是谁、从哪来,记操作日志用
  r.use((req, res, next) => {
    res.locals.ip = clientIp(req);
    if (deps.trustActorHeader) {
      const who = decodeActor(req.get(ACTOR_HEADER));
      res.locals.actor = who?.by || 'MCP';
      if (who?.ip) res.locals.ip = who.ip;
      return next();
    }
    if (loggedIn(req)) {
      res.locals.actor = '后台';
      return next();
    }
    const header = req.get('authorization');
    if (header) {
      const ip = req.ip ?? 'unknown';
      if (!limiter.allow(ip)) return res.status(429).json({ error: '尝试次数过多,请 10 分钟后再试' });
      const tokenId = verifyToken(db, header);
      if (tokenId == null) {
        limiter.fail(ip);
        return res.status(401).json({ error: '令牌无效' });
      }
      if (TOKEN_BLOCKED.test(req.path)) return res.status(403).json({ error: '这个接口不能用 API 令牌调用,要在后台登录后操作' });
      res.locals.actor = `令牌「${tokenName(db, tokenId)}」`;
      return next();
    }
    res.status(401).json({ error: '未登录' });
  });

  // 同一个改东西的请求(同一个 Idempotency-Key)只做一次,重发的拿第一次的结果;放在操作日志前面,重发的不再记日志
  r.use(replayGuard(MUTATING));
  // 操作日志:改东西的请求,处理前记下要动的对象,响应完写一条(谁、做了什么、成没成);查看类的不记,见 oplog/describe.ts
  r.use((req, res, next) => {
    if (!MUTATING.has(req.method)) return next();
    const before = snapshot(db, req.path, req.body);
    let logged = false;
    /** 连接在处理完之前断了(浏览器 / 代理 / CDN 那侧先断):处理照样做完,做完时补记一条 */
    let dropped = false;
    const log = () => {
      if (logged) return;
      logged = true;
      const route = (req.route as { path?: unknown } | undefined)?.path;
      if (typeof route !== 'string') return;
      const ok = res.statusCode < 400;
      try {
        const d = describeOp(db, `${req.method} ${route}`, before, req, res.locals.body, ok);
        if (!d) return;
        const error = ok ? '' : String((res.locals.body as { error?: unknown } | undefined)?.error ?? `HTTP ${res.statusCode}`);
        const summary = dropped ? `${d.summary}(连接中途断开,页面没收到结果)` : d.summary;
        addOpLog(db, { at: Date.now(), actor: String(res.locals.actor ?? '后台'), ip: String(res.locals.ip ?? ''), action: `${req.method} ${route}`, summary, ok, error, customer_id: d.customer_id });
      } catch (e) {
        console.error('记操作日志失败:', e);
      }
    };
    const json = res.json.bind(res);
    res.json = (body: unknown) => {
      res.locals.body = body;
      // 连接已经断了:响应发不出去,'finish' 不会再来,这里就记
      if (dropped) log();
      return json(body);
    };
    res.on('finish', log);
    res.on('close', () => {
      if (res.writableFinished) return;
      dropped = true;
      // 结果已经出来、正发着的时候断的:现在就记
      if (res.headersSent) log();
    });
    next();
  });
  // 操作日志:新的在前;before = 上一页最后一条的 id;customer_id / q(做了什么、谁、IP 里的字)/ failed=1 筛选
  r.get(
    '/oplog',
    wrap((req) => {
      const num = (k: string) => {
        const v = req.query[k];
        if (v === undefined || v === '') return undefined;
        const n = Number(v);
        if (!Number.isSafeInteger(n) || n < 0) throw new InputError(`${k} 要是正整数`);
        return n;
      };
      return listOpLog(db, { before: num('before'), limit: num('limit'), customer_id: num('customer_id'), q: typeof req.query.q === 'string' ? req.query.q : undefined, failed: req.query.failed === '1' });
    }),
  );

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
      const before = getPanel(db, idParam(req));
      const panel = updatePanel(db, idParam(req), req.body ?? {});
      const checked = view(await checkPanel(db, panel, deps.clientFor(panel)));
      // 倍率变了:上面客户的已用当场重算,马上执行一次停用 / 恢复(不等下一轮同步)
      const ops = before && before.traffic_ratio !== panel.traffic_ratio ? await enforceCustomers(db, deps.clientFor) : [];
      return { ...checked, ops };
    }),
  );
  // 面板改成 ?ratio= 这个倍率之后,上面各位客户的已用会变成多少、谁会超额(只算,不改)
  r.get(
    '/panels/:id/ratio-preview',
    wrap((req) => {
      const panel = getPanel(db, idParam(req));
      if (!panel) throw new InputError('面板不存在');
      const ratio = validRatio(req.query.ratio);
      const customers = previewPanelRatio(db, panel.id, ratio);
      return { ratio_before: panel.traffic_ratio, ratio, customers, over_after: customers.filter((c) => c.over_after && !c.over_before).length };
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

  // ---------- geo 库:看面板 Xray 目录里的 geosite / geoip,给出口规则挑分类、核对写法(3x-ui 3.7.0 起有接口) ----------
  const geoFile = (v: unknown): string => {
    const f = String(v ?? '');
    if (!/^[\w.-]{1,100}\.dat$/i.test(f)) throw new InputError('库文件名不对(要 .dat 文件名)');
    return f;
  };
  const geoInt = (v: unknown, def: number, max: number): number => {
    if (v == null || v === '') return def;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0 || n > max) throw new InputError('分页参数不对');
    return n;
  };
  /** 面板太老(没有 geo 接口)时返回 supported: false,界面上提示升级 */
  const geoCall = <T>(req: Request, fn: (client: PanelClient) => Promise<T>) =>
    withClient(panelOf(req), async (client) => {
      try {
        return { supported: true, ...(await fn(client)) };
      } catch (e) {
        if (isGeoUnsupported(e)) return { supported: false };
        throw e;
      }
    });
  r.get(
    '/panels/:id/geodata/files',
    wrap((req) => geoCall(req, async (c) => ({ files: await c.geodataFiles() }))),
  );
  r.get(
    '/panels/:id/geodata/categories',
    wrap((req) => {
      const file = geoFile(req.query.file);
      return geoCall(req, async (c) => ({ items: await c.geodataCategories(file) }));
    }),
  );
  r.get(
    '/panels/:id/geodata/entries',
    wrap((req) => {
      const file = geoFile(req.query.file);
      const code = String(req.query.code ?? '').trim();
      if (!code || code.length > 200 || /[\s,]/.test(code)) throw new InputError('分类名不对');
      const q = String(req.query.q ?? '').trim().slice(0, 100);
      const offset = geoInt(req.query.offset, 0, 10_000_000);
      const limit = Math.max(1, geoInt(req.query.limit, 100, 500));
      return geoCall(req, (c) => c.geodataEntries(file, code, q, offset, limit));
    }),
  );
  // 按面板的库核对写法:kind = site(域名)/ ip;返回对不上的(普通域名、网段不查)
  r.post(
    '/panels/:id/geodata/validate',
    wrap((req) => {
      const kind = req.body?.kind === 'ip' ? 'ip' : req.body?.kind === 'site' ? 'site' : null;
      if (!kind) throw new InputError('kind 只能是 site 或 ip');
      const raw = req.body?.tokens;
      if (!Array.isArray(raw) || raw.length > 5000) throw new InputError('tokens 要是最多 5000 项的数组');
      const tokens = raw.map((x: unknown) => String(x ?? '').trim()).filter((x: string) => x && x.length <= 300);
      return withClient(panelOf(req), async (client) => {
        const issues = await validateTokens(client, kind, tokens);
        return { supported: issues !== null, issues: issues ?? [] };
      });
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
  // 一键改名:这块面板上的线路都用面板的节点名(清掉各自设的)。只改订阅里显示的名字,面板上的客户端、UUID、出口都不动;客户更新订阅后生效
  r.post(
    '/panels/:id/line-names',
    wrap((req) => {
      const panel = panelOf(req);
      if (!panel.node_name) throw new InputError('先给这块面板填节点名');
      return { changed: clearLineNames(db, panel.id), panel: view(panel) };
    }),
  );
  // 重启面板和 Xray 内核:先重启面板、等它回来,再重启 Xray、等它回到 running(上面所有客户端断流几秒)
  r.post(
    '/panels/:id/restart',
    wrap(async (req) => {
      const panel = panelOf(req);
      // 和改这块面板 Xray 配置的操作排队,不在别人改到一半时重启
      await serial(panelKey(panel.id), () =>
        withClient(panel, async (client) => {
          await client.restartPanel();
          await client.restartXray();
        }),
      );
      return view(await checkPanel(db, panel, deps.clientFor(panel)));
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
    const day = subIpsSince(db, Date.now() - 86_400_000);
    const devices = deviceCounts(db);
    const paid = lastPayments(db);
    return customers.map((c) => ({
      ...c,
      sub_url: deps.subBaseUrl ? `${deps.subBaseUrl}/sub/${c.sub_token}` : null,
      sub_clients: counts.get(c.id)?.clients ?? 0,
      sub_ips: counts.get(c.id)?.ips ?? 0,
      // 近 24 小时拉订阅的 IP 数(疑似分享看这个)
      sub_ips_day: day.get(c.id)?.length ?? 0,
      // 拉过订阅的设备数(设备数上限看这个)
      sub_devices: devices.get(c.id) ?? 0,
      // 最近一笔收款(金额大于 0 的)
      last_payment: paid.get(c.id) ?? null,
    }));
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
  // 拉过订阅的设备;删掉一台,名额就让出来(那台再拉订阅会重新占一个)
  r.get('/customers/:id/devices', wrap((req) => listDevices(db, plainCustomer(idParam(req)).id)));
  r.delete('/customers/:id/devices/:did', wrap((req) => void deleteDevice(db, idParam(req), Number(req.params.did))));
  r.get('/customers/:id/sub-fetches', wrap((req) => ({ days: deps.subLogDays, rows: listSubFetches(db, customerOf(idParam(req)).id) })));
  /** 自定义模板地址(新填的 / 改了的)保存前试拉一次,取不到或不是模板就不让存 */
  const checkTemplate = async (input: unknown, current = '') => {
    if (input === undefined) return;
    const next = validTemplate(input);
    if (next !== current && isCustomTemplate(next)) await checkCustomTemplate(next, deps.fetchTemplate);
  };
  /** 新填的外部订阅保存后马上取一次,结果(节点数 / 取不到的原因)跟着客户一起返回;取不到也照样保存 */
  const upstreamFetcher = deps.fetchUpstream ?? fetchUpstream;
  const fetchNewUpstreams = (id: number) => refreshUpstreams(db, id, upstreamFetcher, { onlyNew: true });
  r.post(
    '/customers',
    wrap(async (req) => {
      await checkTemplate(req.body?.sub_template);
      const id = createCustomer(db, req.body ?? {});
      await fetchNewUpstreams(id);
      return customerOf(id);
    }),
  );
  // 外部订阅现在就重新取一遍(不管多久前取过)
  r.post(
    '/customers/:id/upstreams/refresh',
    wrap(async (req) => {
      const c = plainCustomer(idParam(req));
      await refreshUpstreams(db, c.id, upstreamFetcher, { force: true });
      return customerOf(c.id);
    }),
  );
  // 改了额度 / 到期马上执行一次停用 / 恢复,不等下一轮同步
  r.patch(
    '/customers/:id',
    wrap(async (req) => {
      const before = plainCustomer(idParam(req));
      await checkTemplate(req.body?.sub_template, before.sub_template);
      updateCustomer(db, before.id, req.body ?? {});
      const [ops] = await Promise.all([enforceCustomers(db, deps.clientFor, before.id), fetchNewUpstreams(before.id)]);
      return { ...customerOf(before.id), ops };
    }),
  );
  // 续费:在现在的到期日上加 months 个月或 days 天(已过期或没设到期日的从现在起算),记一笔续费记录;
  // amount 填了就是一笔收款(paid_at 收款日期、note 备注);reset_usage 顺带把流量清零
  r.post(
    '/customers/:id/renew',
    wrap(async (req) => {
      const c = plainCustomer(idParam(req));
      const b = req.body ?? {};
      const span = renewSpan(b);
      const now = Date.now();
      const amount = validAmount(b.amount);
      const paidAt = validPaidAt(b.paid_at, now);
      const note = validNote(b.note);
      const expireAt = renewedExpire(c.expire_at, span, now);
      const payment = db.transaction(() => {
        updateCustomer(db, c.id, { expire_at: expireAt });
        return insertPayment(db, { customer_id: c.id, customer_name: c.name, amount, paid_at: paidAt, ...span, expire_before: c.expire_at, expire_after: expireAt, note }, now);
      })();
      const failed = b.reset_usage ? await resetCustomerUsage(db, c, deps.clientFor) : [];
      const ops = await enforceCustomers(db, deps.clientFor, c.id);
      return { ...customerOf(c.id), failed, ops, payment };
    }),
  );
  // 续费 / 收款记录:这位客户的(新的在前);单独记一笔收款(不续期,amount 必填)
  r.get('/customers/:id/payments', wrap((req) => listPayments(db, { customer_id: plainCustomer(idParam(req)).id })));
  r.post(
    '/customers/:id/payments',
    wrap((req) => {
      const c = plainCustomer(idParam(req));
      const b = req.body ?? {};
      const amount = validAmount(b.amount);
      if (amount == null) throw new InputError('要填金额');
      return insertPayment(db, { customer_id: c.id, customer_name: c.name, amount, paid_at: validPaidAt(b.paid_at), expire_before: c.expire_at, expire_after: c.expire_at, note: validNote(b.note) });
    }),
  );
  // 全部客户的续费 / 收款记录:from / to(毫秒)= 收款日期在 [from, to) 里的,不给就是全部
  r.get(
    '/payments',
    wrap((req) => {
      const ms = (k: string) => {
        const v = req.query[k];
        if (v === undefined || v === '') return undefined;
        const n = Number(v);
        if (!Number.isSafeInteger(n) || n < 0) throw new InputError(`${k} 要是毫秒时间戳`);
        return n;
      };
      return listPayments(db, { from: ms('from'), to: ms('to') });
    }),
  );
  // 删一笔记录(记错了):只删记录,到期日不变
  r.delete('/payments/:id', wrap((req) => void deletePayment(db, idParam(req))));
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
  // 调整本期已用(计费用量,不乘倍率):up / down 加减的字节,记进结转;调完马上执行一次停用 / 恢复
  r.post(
    '/customers/:id/adjust-usage',
    wrap(async (req) => {
      const c = plainCustomer(idParam(req));
      adjustUsage(db, c.id, { up: req.body?.up, down: req.body?.down });
      const ops = await enforceCustomers(db, deps.clientFor, c.id);
      return { ...customerOf(c.id), ops };
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
  // 流量统计:by=customer|panel,days=最近几天;带 id 时展开这位客户 / 这块面板名下的各个客户端;exclude=1,2 不算这些面板上的流量;
  // customers=3,0 只算这些客户的(0 = 没归入客户的客户端)
  r.get(
    '/traffic',
    wrap(async (req) => {
      const by = req.query.by === 'panel' ? 'panel' : 'customer';
      const id = req.query.id === undefined || req.query.id === '' ? null : Number(req.query.id);
      if (id != null && !(Number.isInteger(id) && id >= 0)) throw new InputError('id 不对');
      const ids = (k: string) => (typeof req.query[k] === 'string' ? (req.query[k] as string).split(',').filter((x) => x.trim() !== '') : []).map(Number);
      const exclude = ids('exclude');
      if (exclude.some((x) => !(Number.isInteger(x) && x > 0))) throw new InputError('exclude 要是逗号分隔的面板 id');
      const customers = ids('customers');
      if (customers.some((x) => !(Number.isInteger(x) && x >= 0))) throw new InputError('customers 要是逗号分隔的客户 id(0 = 没归入客户的)');
      return trafficReport(db, { by, days: Number(req.query.days) || 30, id, exclude, customers });
    }),
  );
  // xui-hub 自己的版本:当前版本、GitHub 上最新的发布版本、能不能在后台里直接更新;refresh=1 重新查一次
  r.get(
    '/system/version',
    wrap((req) => {
      if (!deps.updater) throw new InputError('没有启用版本检查');
      return deps.updater.info(req.query.refresh === '1');
    }),
  );
  // 更新到最新版:只是发起,更新在后台跑,期间服务会重启;前端轮询 /system/version 看版本变没变
  r.post(
    '/system/update',
    wrap(async () => {
      if (!deps.updater) throw new InputError('没有启用版本检查');
      await deps.updater.start();
      return { started: true };
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
  // 开线路:直出,或走登记的 SOCKS 出口(见 lines/open.ts)
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
      return withClient(panel, async (client) => ({ links: renameLinks(await client.clientLinks(line.email), lineNodeName(line)) }));
    }),
  );
  // 改线路的自定义节点名(只改这里,面板上不动;下次拉订阅生效)
  r.patch(
    '/customers/:id/lines/:lid',
    wrap((req) => {
      const line = lineOf(req);
      if (req.body?.node_name !== undefined) setLineName(db, line.id, validNodeName(req.body.node_name));
      return getLine(db, line.id);
    }),
  );
  // 线路的出口规则:写到这块面板的 Xray 路由并重启 Xray,整组替换,空数组 = 去掉
  r.put(
    '/customers/:id/lines/:lid/rules',
    wrap(async (req) => {
      const line = lineOf(req);
      return applyLineRules(db, line, validRules(db, req.body?.rules), deps.clientFor);
    }),
  );
  // 批量删线路:line_ids 里的线路,面板上的 client 和出口规则一起删(同一块面板只连一次、Xray 最多重启一次),
  // 删成了的再删记录(本期流量结转到客户身上)。面板上没删成的留着记录、带原因返回;force = true 时不管面板删没删成都删记录
  r.post(
    '/lines/batch-delete',
    wrap(async (req) => {
      const raw = req.body?.line_ids;
      if (!Array.isArray(raw) || !raw.length || raw.length > 1000) throw new InputError('line_ids 要是 1 到 1000 个线路 id 的数组');
      const ids = [...new Set(raw.map(Number))];
      const bad = ids.find((id) => !Number.isInteger(id) || id <= 0);
      if (bad !== undefined) throw new InputError(`线路 id 不对:${raw.find((x: unknown) => Number(x) === bad)}`);
      // 已经不在的(别处删掉了,或页面没刷新)跳过,不连累同一批的其它线路;放在 missing 里返回
      const lines = ids.flatMap((id) => getLine(db, id) ?? []);
      const missing = ids.filter((id) => !lines.some((l) => l.id === id));
      const force = req.body?.force === true;
      const failed = await removeLines(db, lines, deps.clientFor);
      const failedIds = new Set(force ? [] : failed.map((f) => f.line.id));
      const deleted: number[] = [];
      for (const line of lines) {
        if (failedIds.has(line.id)) continue;
        deleteLine(db, line.id);
        deleted.push(line.id);
      }
      return { deleted, missing, failed: force ? [] : failed.map(({ line, error }) => ({ id: line.id, line: lineLabel(line), error: errorText(error) })) };
    }),
  );
  // 线路原地换出口:exit = { kind: 'socks', socks_id } 或 { kind: 'direct' }。不删线路、UUID 不变,客户不用更新订阅;
  // 这块面板重启一次 Xray(已经是这个出口就不动)。带条件的出口规则、面板上手配的规则不碰
  r.put(
    '/customers/:id/lines/:lid/exit',
    wrap(async (req) => {
      const line = lineOf(req);
      const { failed } = await changeLineExits(db, [line], parseExitTarget(req.body?.exit), deps.clientFor);
      if (failed.length) throw failed[0].error;
      return getLine(db, line.id);
    }),
  );
  // 批量换出口:line_ids(挑几条)或 customer_id(这位客户的全部线路;两个都给 = 这位客户的这几条)。
  // 同一块面板上的一起改,只连一次、只重启一次 Xray;哪块面板没成,只有那块上的线路不改,带原因返回
  r.post(
    '/lines/batch-exit',
    wrap(async (req) => {
      const target = parseExitTarget(req.body?.exit);
      const raw = req.body?.line_ids;
      const owner = req.body?.customer_id == null ? null : plainCustomer(Number(req.body.customer_id));
      let lines: Line[];
      if (raw == null) {
        if (!owner) throw new InputError('要给 line_ids 或 customer_id');
        lines = owner.lines;
      } else {
        if (!Array.isArray(raw) || !raw.length || raw.length > 1000) throw new InputError('line_ids 要是 1 到 1000 个线路 id 的数组');
        lines = [...new Set(raw.map(Number))].map((id) => {
          const line = Number.isInteger(id) && id > 0 ? getLine(db, id) : undefined;
          if (!line || (owner && line.customer_id !== owner.id)) throw new InputError(`线路 ${raw.find((x: unknown) => Number(x) === id)} 不存在${owner ? `或不是「${owner.name}」的` : ''}`);
          return line;
        });
      }
      if (!lines.length) throw new InputError('没有要换出口的线路');
      const { changed, failed } = await changeLineExits(db, lines, target, deps.clientFor);
      return { changed: changed.map((l) => l.id), lines: changed, failed: failed.map(({ line, error }) => ({ id: line.id, line: lineLabel(line), error: errorText(error) })) };
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
  // 换了地址 / 账号:先把走它的线路在各自面板上改指到新地址,都改成了才保存
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

  // ---------- 开放 API 的令牌(只能登录后管理) ----------
  r.get('/tokens', wrap(() => listTokens(db)));
  r.post('/tokens', wrap((req) => createToken(db, req.body ?? {})));
  r.delete('/tokens/:id', wrap((req) => void deleteToken(db, idParam(req))));
  // 经 OAuth 授权过的 MCP 应用;撤销后它手里的令牌立即失效
  r.get('/oauth-grants', wrap(() => listGrants(db)));
  r.delete('/oauth-grants/:id', wrap((req) => void revokeGrant(db, idParam(req))));

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
  const restoreWith = (data: Buffer, res: Response) => {
    if (!deps.dataDir) throw new InputError('这个部署不支持在线恢复');
    const info = inspectBackup(data);
    stageRestore(deps.dataDir, data);
    res.json({ ...info, restarting: !!deps.onRestore });
    if (deps.onRestore) setTimeout(deps.onRestore, 500);
  };
  r.post(
    '/restore',
    raw({ type: () => true, limit: '256mb' }),
    wrap((req, res) => restoreWith(Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0), res)),
  );

  // ---------- 异地备份(S3 / R2) ----------
  const remoteCfg = () => {
    const c = getSettings(db).backup.remote;
    if (!remoteEnabled(c)) throw new InputError('先在上面填好对象存储的 Endpoint、桶名和密钥并保存');
    return c;
  };
  const remoteCall = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof InputError) throw e;
      throw new InputError(s3Error(e));
    }
  };
  // 远端有哪些备份 + 上次自动 / 手动备份的结果
  r.get(
    '/backup/remote',
    wrap(async () => {
      const last = remoteStatus(db);
      const c = getSettings(db).backup.remote;
      if (!remoteEnabled(c)) return { enabled: false, last, files: [] };
      return { enabled: true, last, files: (await remoteCall(() => listRemote(c))).slice(0, 50) };
    }),
  );
  // 现在就传一份(顺带清理过期的)
  r.post('/backup/remote', wrap(() => remoteCall(() => runRemoteBackup(db, remoteCfg()))));
  // 用远端的某一份恢复
  r.post(
    '/backup/remote/restore',
    wrap(async (req, res) => {
      const key = String(req.body?.key ?? '');
      if (!key) throw new InputError('要指定 key');
      restoreWith(await remoteCall(() => downloadBackup(remoteCfg(), key)), res);
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
