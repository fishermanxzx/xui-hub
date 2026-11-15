// MCP 的 OAuth 授权(xui-hub 自己当授权服务器):OAuth 2.1 授权码 + PKCE(S256),公开客户端,不发 client_secret。
// 客户端怎么来:动态注册(RFC 7591,POST /oauth/register),或 client_id 就是一个 https 地址(Client ID Metadata Document,现取现验)。
// 用户在授权页输入后台密码并点「允许」才发授权码;令牌库里只存 SHA-256。
// 发现:/.well-known/oauth-protected-resource(RFC 9728)、/.well-known/oauth-authorization-server(RFC 8414)。

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import express, { Router, type Request, type Response } from 'express';
import type { DB } from '../db';
import { LoginLimiter, passwordMatches } from '../http/auth';
import { InputError } from '../panels/repo';

const ACCESS_TTL_MS = 3_600_000;
const REFRESH_TTL_MS = 60 * 86_400_000;
const CODE_TTL_MS = 600_000;
export const SCOPE = 'mcp';
const ACCESS_PREFIX = 'xho_';
const REFRESH_PREFIX = 'xhr_';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const rand = (n = 32) => randomBytes(n).toString('base64url');
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export interface OAuthClient {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
}

export interface OAuthGrant {
  id: number;
  client_id: string;
  client_name: string;
  created_at: number;
  last_used_at: number | null;
}

export type DocFetcher = (url: string) => Promise<{ status: number; body: string }>;

/** 取 Client ID Metadata Document:只走 https,最多等 5 秒、读 64 KB,不跟重定向 */
export const fetchClientDoc: DocFetcher = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: 'error', headers: { Accept: 'application/json', 'User-Agent': 'xui-hub' } });
  return { status: res.status, body: (await res.text()).slice(0, 65_536) };
};

const PRIVATE_HOST = /^(localhost$|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.|\[?::1\]?$|\[?f[cde][0-9a-f]*:)/i;
const isLoopbackHost = (h: string) => h === 'localhost' || h === '127.0.0.1' || h === '[::1]';

/** 回调地址:https、本机的 http(桌面客户端在本机起的临时端口),或客户端自己的协议(cursor:// 之类);不收 javascript: 等 */
export function validRedirectUri(value: unknown): string {
  const v = String(value ?? '');
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    throw new InputError('redirect_uri 不是合法的地址');
  }
  if (v.length > 500 || u.hash) throw new InputError('redirect_uri 不合法');
  if (u.protocol === 'https:') return v;
  if (u.protocol === 'http:') {
    if (!isLoopbackHost(u.hostname)) throw new InputError('http 的 redirect_uri 只能是本机地址');
    return v;
  }
  if (/^(javascript|data|vbscript|file|blob|about):$/i.test(u.protocol)) throw new InputError('redirect_uri 的协议不允许');
  return v;
}

/** 登记过的回调地址里有没有这一个:要完全一致;本机地址端口可以不同(桌面客户端每次端口不一样,RFC 8252) */
export function redirectAllowed(registered: string[], given: string): boolean {
  if (registered.includes(given)) return true;
  let g: URL;
  try {
    g = new URL(given);
  } catch {
    return false;
  }
  if (g.protocol !== 'http:' || !isLoopbackHost(g.hostname)) return false;
  return registered.some((r) => {
    try {
      const u = new URL(r);
      return u.protocol === 'http:' && isLoopbackHost(u.hostname) && u.hostname === g.hostname && u.pathname === g.pathname && u.search === g.search;
    } catch {
      return false;
    }
  });
}

export function pkceMatches(challenge: string, verifier: unknown): boolean {
  if (typeof verifier !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;
  const a = Buffer.from(createHash('sha256').update(verifier).digest('base64url'));
  const b = Buffer.from(challenge);
  return a.length === b.length && timingSafeEqual(a, b);
}

// ---------- 存取 ----------

function registerClient(db: DB, input: any, now = Date.now()): OAuthClient {
  const uris = Array.isArray(input?.redirect_uris) ? input.redirect_uris : [];
  if (!uris.length || uris.length > 10) throw new InputError('redirect_uris 要有 1 到 10 个');
  const redirect_uris = uris.map(validRedirectUri);
  const client_name = String(input?.client_name ?? '').trim().slice(0, 100) || 'MCP 客户端';
  // 没人授权过的注册记录一天后清掉;总数封顶,防被刷
  db.prepare('DELETE FROM oauth_clients WHERE created_at < ? AND client_id NOT IN (SELECT client_id FROM oauth_grants)').run(now - 86_400_000);
  if ((db.prepare('SELECT COUNT(*) AS n FROM oauth_clients').get() as { n: number }).n >= 500) throw new InputError('注册的客户端太多,稍后再试');
  const client_id = `mcp_${rand(16)}`;
  db.prepare('INSERT INTO oauth_clients (client_id, client_name, redirect_uris, created_at) VALUES (?, ?, ?, ?)').run(client_id, client_name, JSON.stringify(redirect_uris), now);
  return { client_id, client_name, redirect_uris };
}

/** client_id → 客户端。注册过的查库;https 地址形式的现取它的元数据文档 */
async function resolveClient(db: DB, clientId: string, fetchDoc: DocFetcher): Promise<OAuthClient> {
  const row = db.prepare('SELECT client_id, client_name, redirect_uris FROM oauth_clients WHERE client_id = ?').get(clientId) as { client_id: string; client_name: string; redirect_uris: string } | undefined;
  if (row) return { client_id: row.client_id, client_name: row.client_name, redirect_uris: JSON.parse(row.redirect_uris) };
  let u: URL | null = null;
  try {
    u = new URL(clientId);
  } catch {
    /* 不是地址 */
  }
  if (!u || u.protocol !== 'https:' || u.pathname === '/' || u.hash || u.username || PRIVATE_HOST.test(u.hostname)) throw new InputError('不认识这个 client_id');
  let doc: any;
  try {
    const got = await fetchDoc(clientId);
    if (got.status !== 200) throw new Error(`返回 ${got.status}`);
    doc = JSON.parse(got.body);
  } catch (e) {
    throw new InputError(`取不到客户端的元数据文档:${e instanceof Error ? e.message : e}`);
  }
  if (doc?.client_id !== clientId) throw new InputError('元数据文档里的 client_id 和地址不一致');
  if (!Array.isArray(doc.redirect_uris) || !doc.redirect_uris.length) throw new InputError('元数据文档里没有 redirect_uris');
  return { client_id: clientId, client_name: String(doc.client_name ?? u.hostname).slice(0, 100), redirect_uris: doc.redirect_uris.slice(0, 20).map(validRedirectUri) };
}

export function listGrants(db: DB): OAuthGrant[] {
  return db.prepare('SELECT id, client_id, client_name, created_at, last_used_at FROM oauth_grants ORDER BY id').all() as OAuthGrant[];
}

export function revokeGrant(db: DB, id: number): void {
  if (!db.prepare('DELETE FROM oauth_grants WHERE id = ?').run(id).changes) throw new InputError('授权不存在');
}

function issueTokens(db: DB, grantId: number, now: number) {
  const access = ACCESS_PREFIX + rand();
  const refresh = REFRESH_PREFIX + rand();
  db.prepare('DELETE FROM oauth_access WHERE expires_at < ?').run(now);
  db.prepare('INSERT INTO oauth_access (hash, grant_id, expires_at) VALUES (?, ?, ?)').run(sha(access), grantId, now + ACCESS_TTL_MS);
  // 刷新令牌每次换新,旧的作废
  db.prepare('UPDATE oauth_grants SET refresh_hash = ?, refresh_expires_at = ? WHERE id = ?').run(sha(refresh), now + REFRESH_TTL_MS, grantId);
  return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL_MS / 1000, refresh_token: refresh, scope: SCOPE };
}

/** Authorization 头里的 OAuth 访问令牌有效就返回授权 id */
export function verifyAccessToken(db: DB, header: string | undefined, now = Date.now()): number | undefined {
  const m = /^Bearer\s+(\S+)$/i.exec(header ?? '');
  if (!m || !m[1].startsWith(ACCESS_PREFIX)) return undefined;
  const row = db.prepare('SELECT a.grant_id, g.last_used_at FROM oauth_access a JOIN oauth_grants g ON g.id = a.grant_id WHERE a.hash = ? AND a.expires_at > ?').get(sha(m[1]), now) as { grant_id: number; last_used_at: number | null } | undefined;
  if (!row) return undefined;
  if (!row.last_used_at || now - row.last_used_at > 60_000) db.prepare('UPDATE oauth_grants SET last_used_at = ? WHERE id = ?').run(now, row.grant_id);
  return row.grant_id;
}

// ---------- 路由 ----------

export interface OAuthDeps {
  db: DB;
  adminPassword: string;
  /** 取 Client ID Metadata Document;测试里换成假的 */
  fetchClientDoc?: DocFetcher;
}

export const baseUrlOf = (req: Request) => `${req.protocol}://${req.get('host')}`;
export const resourceMetadataUrl = (req: Request) => `${baseUrlOf(req)}/.well-known/oauth-protected-resource/mcp`;

interface PendingCode {
  client_id: string;
  client_name: string;
  redirect_uri: string;
  challenge: string;
  expires_at: number;
}

interface AuthParams {
  client_id: string;
  redirect_uri: string;
  state: string;
  code_challenge: string;
  code_challenge_method: string;
  response_type: string;
  scope: string;
  resource: string;
}

const PARAM_KEYS = ['client_id', 'redirect_uri', 'state', 'code_challenge', 'code_challenge_method', 'response_type', 'scope', 'resource'] as const;

function consentPage(p: AuthParams, client: OAuthClient, needPassword: boolean, error = ''): string {
  let where = p.redirect_uri;
  try {
    const u = new URL(p.redirect_uri);
    where = u.protocol === 'https:' || u.protocol === 'http:' ? u.host : `${u.protocol}//…`;
  } catch {
    /* 原样显示 */
  }
  const hidden = PARAM_KEYS.map((k) => `<input type="hidden" name="${k}" value="${esc(p[k])}">`).join('');
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>授权访问 xui-hub</title>
<style>
:root{--bg:#f5f6f8;--sheet:#fff;--ink:#15181e;--soft:#667085;--rule:#e4e7ec;--accent:#5157e0;--bad:#d92d20;--bad-bg:#fef3f2}
@media(prefers-color-scheme:dark){:root{--bg:#0a0b0d;--sheet:#111318;--ink:#ededf0;--soft:#8b8f98;--rule:#23262d;--accent:#7b80ff;--bad:#f87171;--bad-bg:#2d1414}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei","Noto Sans SC",sans-serif}
.wrap{max-width:440px;margin:0 auto;padding:48px 16px}.card{background:var(--sheet);border:1px solid var(--rule);border-radius:12px;padding:24px}
h1{font-size:19px;margin:0 0 12px}p{margin:0 0 12px}.muted{color:var(--soft);font-size:13px}ul{margin:0 0 16px;padding-left:20px}li{margin:2px 0}
label{display:block;font-size:13px;color:var(--soft);margin-bottom:16px}input[type=password]{display:block;width:100%;margin-top:6px;font:inherit;padding:9px 10px;border:1px solid var(--rule);border-radius:8px;background:var(--bg);color:var(--ink)}
.row{display:flex;gap:10px;justify-content:flex-end}button{font:inherit;font-size:14px;padding:9px 18px;border-radius:8px;border:1px solid var(--rule);background:var(--sheet);color:var(--ink);cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}.err{background:var(--bad-bg);color:var(--bad);border-radius:8px;padding:10px 12px;margin-bottom:12px;font-size:14px}
code{font-size:12px;word-break:break-all}
</style></head>
<body><div class="wrap"><div class="card">
<h1>「${esc(client.client_name)}」想连接你的 xui-hub</h1>
<p>允许后,它可以通过 MCP:</p>
<ul><li>查看客户、线路、面板和订阅链接</li><li>新建、修改、续期、删除客户</li><li>开线路、删线路(会改动面板上的客户端)</li></ul>
<p class="muted">它改不了后台设置,也碰不了备份、API 令牌和面板的接入信息。授权后会跳回 <code>${esc(where)}</code>;之后可以在后台「设置」里随时撤销。</p>
${error ? `<div class="err">${esc(error)}</div>` : ''}
<form method="post" action="">${hidden}
${needPassword ? '<label>后台密码<input type="password" name="password" autocomplete="current-password" required autofocus></label>' : ''}
<div class="row"><button name="action" value="deny" formnovalidate>拒绝</button><button class="primary" name="action" value="allow">允许</button></div>
</form>
</div></div></body></html>`;
}

const errorPage = (message: string) =>
  `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>授权失败</title></head><body style="font:15px/1.6 -apple-system,sans-serif;max-width:440px;margin:48px auto;padding:0 16px"><h1 style="font-size:19px">授权请求有问题</h1><p>${esc(message)}</p><p style="color:#667085;font-size:13px">这通常是客户端的问题,回到客户端重新发起连接。</p></body></html>`;

export function oauthRouter(deps: OAuthDeps): Router {
  const { db } = deps;
  const authEnabled = deps.adminPassword !== '';
  const fetchDoc = deps.fetchClientDoc ?? fetchClientDoc;
  const loginLimiter = new LoginLimiter();
  const registerLimiter = new LoginLimiter();
  const codes = new Map<string, PendingCode>();
  const r = Router();
  const form = express.urlencoded({ extended: false, limit: '20kb' });
  const json = express.json({ limit: '20kb' });

  // 浏览器里的 MCP 客户端也要能读元数据、注册、换令牌
  const cors = (_req: Request, res: Response, next: () => void) => {
    res.set({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization, MCP-Protocol-Version', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' });
    next();
  };
  const preflight = (_req: Request, res: Response) => void res.status(204).end();

  const protectedResource = (req: Request, res: Response) => {
    const base = baseUrlOf(req);
    res.json({ resource: `${base}/mcp`, authorization_servers: [base], scopes_supported: [SCOPE], bearer_methods_supported: ['header'], resource_name: 'xui-hub' });
  };
  for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
    r.options(path, cors, preflight);
    r.get(path, cors, protectedResource);
  }
  r.options('/.well-known/oauth-authorization-server', cors, preflight);
  r.get('/.well-known/oauth-authorization-server', cors, (req, res) => {
    const base = baseUrlOf(req);
    res.json({
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      registration_endpoint: `${base}/oauth/register`,
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: [SCOPE],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    });
  });

  // 动态注册:谁都能调(规范如此),所以按 IP 限次、总数封顶;注册本身拿不到任何权限
  r.options('/oauth/register', cors, preflight);
  r.post('/oauth/register', cors, json, (req, res) => {
    const ip = req.ip ?? 'unknown';
    if (!registerLimiter.allow(ip)) return void res.status(429).json({ error: 'too_many_requests' });
    registerLimiter.fail(ip);
    try {
      const c = registerClient(db, req.body);
      res.status(201).json({
        client_id: c.client_id,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        client_name: c.client_name,
        redirect_uris: c.redirect_uris,
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        scope: SCOPE,
        ...(typeof req.body?.application_type === 'string' ? { application_type: req.body.application_type } : {}),
      });
    } catch (e) {
      res.status(400).json({ error: 'invalid_client_metadata', error_description: e instanceof Error ? e.message : String(e) });
    }
  });

  const readParams = (src: any): AuthParams => Object.fromEntries(PARAM_KEYS.map((k) => [k, typeof src?.[k] === 'string' ? src[k] : ''])) as unknown as AuthParams;

  /** 校验授权请求。client / 回调地址不对的不能跳回去(会把人送到别人的地址),直接出错误页;其余错误按规范带着 error 跳回客户端 */
  const check = async (req: Request, res: Response, p: AuthParams): Promise<OAuthClient | null> => {
    res.set({ 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "frame-ancestors 'none'", 'Referrer-Policy': 'no-referrer' });
    let client: OAuthClient;
    try {
      client = await resolveClient(db, p.client_id, fetchDoc);
      if (!redirectAllowed(client.redirect_uris, p.redirect_uri)) throw new InputError('redirect_uri 和这个客户端登记的不一致');
    } catch (e) {
      res.status(400).type('html').send(errorPage(e instanceof Error ? e.message : String(e)));
      return null;
    }
    const fail = (error: string, description: string) => {
      redirectBack(req, res, p, { error, error_description: description });
      return null;
    };
    if (p.response_type !== 'code') return fail('unsupported_response_type', 'only response_type=code is supported');
    if (!p.code_challenge || p.code_challenge_method !== 'S256') return fail('invalid_request', 'PKCE with code_challenge_method=S256 is required');
    if (p.resource && !p.resource.replace(/\/+$/, '').toLowerCase().startsWith(baseUrlOf(req).toLowerCase())) return fail('invalid_target', 'resource does not belong to this server');
    return client;
  };

  const redirectBack = (req: Request, res: Response, p: AuthParams, params: Record<string, string>) => {
    const u = new URL(p.redirect_uri);
    for (const [k, v] of Object.entries({ ...params, ...(p.state ? { state: p.state } : {}), iss: baseUrlOf(req) })) u.searchParams.set(k, v);
    res.redirect(302, u.toString());
  };

  r.get('/oauth/authorize', async (req, res) => {
    const p = readParams(req.query);
    const client = await check(req, res, p);
    if (client) res.type('html').send(consentPage(p, client, authEnabled));
  });

  r.post('/oauth/authorize', form, async (req, res) => {
    const p = readParams(req.body);
    const client = await check(req, res, p);
    if (!client) return;
    if (req.body?.action !== 'allow') return redirectBack(req, res, p, { error: 'access_denied', error_description: 'the user denied the request' });
    if (authEnabled) {
      const ip = req.ip ?? 'unknown';
      if (!loginLimiter.allow(ip)) return void res.status(429).type('html').send(consentPage(p, client, true, '尝试次数过多,请 10 分钟后再试'));
      if (!passwordMatches(deps.adminPassword, req.body?.password)) {
        loginLimiter.fail(ip);
        return void res.status(401).type('html').send(consentPage(p, client, true, '密码错误'));
      }
      loginLimiter.clear(ip);
    }
    const now = Date.now();
    for (const [k, v] of codes) if (v.expires_at <= now) codes.delete(k);
    const code = rand();
    codes.set(sha(code), { client_id: client.client_id, client_name: client.client_name, redirect_uri: p.redirect_uri, challenge: p.code_challenge, expires_at: now + CODE_TTL_MS });
    redirectBack(req, res, p, { code });
  });

  r.options('/oauth/token', cors, preflight);
  r.post('/oauth/token', cors, form, json, (req, res) => {
    res.set({ 'Cache-Control': 'no-store', Pragma: 'no-cache' });
    const b = req.body ?? {};
    const bad = (error: string, description: string, status = 400) => void res.status(status).json({ error, error_description: description });
    const now = Date.now();
    if (b.grant_type === 'authorization_code') {
      const key = sha(String(b.code ?? ''));
      const pending = codes.get(key);
      // 授权码只能用一次
      codes.delete(key);
      if (!pending || pending.expires_at <= now) return bad('invalid_grant', 'authorization code is invalid or expired');
      if (pending.client_id !== b.client_id || pending.redirect_uri !== b.redirect_uri) return bad('invalid_grant', 'client_id or redirect_uri does not match the authorization request');
      if (!pkceMatches(pending.challenge, b.code_verifier)) return bad('invalid_grant', 'code_verifier does not match');
      const grantId = Number(db.prepare('INSERT INTO oauth_grants (client_id, client_name, created_at) VALUES (?, ?, ?)').run(pending.client_id, pending.client_name, now).lastInsertRowid);
      return void res.json(issueTokens(db, grantId, now));
    }
    if (b.grant_type === 'refresh_token') {
      const token = String(b.refresh_token ?? '');
      const grant = token.startsWith(REFRESH_PREFIX)
        ? (db.prepare('SELECT id, client_id FROM oauth_grants WHERE refresh_hash = ? AND refresh_expires_at > ?').get(sha(token), now) as { id: number; client_id: string } | undefined)
        : undefined;
      if (!grant || (b.client_id && b.client_id !== grant.client_id)) return bad('invalid_grant', 'refresh token is invalid or expired');
      return void res.json(issueTokens(db, grant.id, now));
    }
    bad('unsupported_grant_type', 'only authorization_code and refresh_token are supported');
  });

  return r;
}
