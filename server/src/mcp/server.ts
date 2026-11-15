// MCP 服务端点 POST /mcp(Streamable HTTP,只回 JSON,不开 SSE 流)。不存会话,每个请求独立处理。
// 两代协议都接:
// - 2026-07-28 起(无握手):每个请求在 _meta 和 MCP-Protocol-Version 头里带版本,还带 Mcp-Method / Mcp-Name 头;
// - 2025-03-26 ~ 2025-11-25(有握手):initialize → notifications/initialized → tools/list / tools/call。
// 鉴权:Authorization: Bearer 带 API 令牌(xh_…,后台「设置」里生成)或 OAuth 访问令牌(xho_…,见 oauth.ts)。
// 没带或无效回 401,WWW-Authenticate 里指向受保护资源的元数据,客户端据此走 OAuth。

import express, { Router, type Request, type Response } from 'express';
import type { DB } from '../db';
import { LoginLimiter } from '../http/auth';
import { verifyToken } from '../http/tokens';
import { baseUrlOf, resourceMetadataUrl, SCOPE, verifyAccessToken } from './oauth';
import { callTool, hasTool, INSTRUCTIONS, toolList, type ApiCall } from './tools';

export const MODERN_VERSIONS = ['2026-07-28'];
export const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];
const META_VERSION = 'io.modelcontextprotocol/protocolVersion';
const META_SERVER = 'io.modelcontextprotocol/serverInfo';

const E_PARSE = -32700;
const E_INVALID_REQUEST = -32600;
const E_METHOD_NOT_FOUND = -32601;
const E_INVALID_PARAMS = -32602;
const E_HEADER_MISMATCH = -32020;
const E_UNSUPPORTED_VERSION = -32022;

export interface McpDeps {
  db: DB;
  adminPassword: string;
  /** 调后台 /api 的内部通道 */
  api: ApiCall;
  version: string;
}

interface Reply {
  status: number;
  body?: unknown;
}

const rpcError = (id: unknown, code: number, message: string, data?: unknown) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data === undefined ? {} : { data }) } });
const rpcResult = (id: unknown, result: unknown) => ({ jsonrpc: '2.0', id, result });

/** Mcp-Name 头的值;非 ASCII 的名字客户端会写成 =?base64?…?= */
function decodeHeader(value: string): string {
  const m = /^=\?base64\?(.*)\?=$/.exec(value);
  return m ? Buffer.from(m[1], 'base64').toString('utf8') : value;
}

export function mcpRouter(deps: McpDeps): Router {
  const { db } = deps;
  const authEnabled = deps.adminPassword !== '';
  const limiter = new LoginLimiter();
  const serverInfo = { name: 'xui-hub', title: 'xui-hub', version: deps.version };
  const r = Router();

  r.use('/mcp', (req, res, next) => {
    res.set({
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, MCP-Protocol-Version, Mcp-Method, Mcp-Name, Mcp-Session-Id, Last-Event-ID',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Expose-Headers': 'WWW-Authenticate',
    });
    if (req.method === 'OPTIONS') return void res.status(204).end();
    // 没有会话、不开独立的 SSE 流:GET / DELETE 一律 405
    if (req.method !== 'POST') return void res.status(405).set('Allow', 'POST, OPTIONS').json(rpcError(null, E_INVALID_REQUEST, 'Method not allowed: this endpoint only accepts POST'));

    if (!authEnabled) {
      // 没设后台密码(只监听本机)时不鉴权,这时要防 DNS 重绑定:浏览器带来的 Origin 必须就是这个地址
      const origin = req.get('origin');
      if (origin && origin !== baseUrlOf(req)) return void res.status(403).json(rpcError(null, E_INVALID_REQUEST, 'Forbidden: invalid Origin'));
      return next();
    }
    const header = req.get('authorization');
    const challenge = (error?: string) => `Bearer resource_metadata="${resourceMetadataUrl(req)}", scope="${SCOPE}"${error ? `, error="${error}"` : ''}`;
    if (!header) return void res.status(401).set('WWW-Authenticate', challenge()).json(rpcError(null, E_INVALID_REQUEST, 'Unauthorized: send an API token or an OAuth access token as a Bearer token'));
    const ip = req.ip ?? 'unknown';
    if (!limiter.allow(ip)) return void res.status(429).json(rpcError(null, E_INVALID_REQUEST, 'Too many failed attempts, try again in 10 minutes'));
    if (verifyToken(db, header) == null && verifyAccessToken(db, header) == null) {
      limiter.fail(ip);
      return void res.status(401).set('WWW-Authenticate', challenge('invalid_token')).json(rpcError(null, E_INVALID_REQUEST, 'Unauthorized: token is invalid or expired'));
    }
    next();
  });

  const toolContext = (req: Request) => ({ api: deps.api, baseUrl: baseUrlOf(req) });

  /** 2026-07-28 起的无握手协议 */
  async function modern(req: Request, msg: any, version: string): Promise<Reply> {
    const id = msg.id;
    const fail = (status: number, code: number, message: string, data?: unknown): Reply => ({ status, body: rpcError(id, code, message, data) });
    if (!MODERN_VERSIONS.includes(version)) {
      return fail(400, E_UNSUPPORTED_VERSION, 'Unsupported protocol version', { supported: [...MODERN_VERSIONS, ...LEGACY_VERSIONS], requested: version });
    }
    // 头和正文要对得上(中间的网关按头路由,服务端按正文执行,两边不一致就是隐患)
    const hVersion = req.get('mcp-protocol-version');
    if (!hVersion) return fail(400, E_HEADER_MISMATCH, 'Header mismatch: MCP-Protocol-Version header is required');
    if (hVersion !== version) return fail(400, E_HEADER_MISMATCH, `Header mismatch: MCP-Protocol-Version header value '${hVersion}' does not match body value '${version}'`);
    const hMethod = req.get('mcp-method');
    if (!hMethod) return fail(400, E_HEADER_MISMATCH, 'Header mismatch: Mcp-Method header is required');
    if (hMethod !== msg.method) return fail(400, E_HEADER_MISMATCH, `Header mismatch: Mcp-Method header value '${hMethod}' does not match body value '${msg.method}'`);
    if (msg.id === undefined) return { status: 202 };

    const done = (result: Record<string, unknown>): Reply => ({ status: 200, body: rpcResult(id, { resultType: 'complete', ...result, _meta: { [META_SERVER]: serverInfo } }) });
    switch (msg.method) {
      case 'server/discover':
        return done({ supportedVersions: [...MODERN_VERSIONS, ...LEGACY_VERSIONS], capabilities: { tools: {} }, instructions: INSTRUCTIONS, ttlMs: 3_600_000, cacheScope: 'public' });
      case 'tools/list':
        return done({ tools: toolList(), ttlMs: 3_600_000, cacheScope: 'public' });
      case 'tools/call': {
        const name = msg.params?.name;
        const hName = req.get('mcp-name');
        if (!hName) return fail(400, E_HEADER_MISMATCH, 'Header mismatch: Mcp-Name header is required for tools/call');
        if (decodeHeader(hName) !== name) return fail(400, E_HEADER_MISMATCH, `Header mismatch: Mcp-Name header value '${decodeHeader(hName)}' does not match body value '${name}'`);
        if (!hasTool(name)) return fail(200, E_INVALID_PARAMS, `Unknown tool: ${name}`);
        return done(await callTool(name, msg.params?.arguments, toolContext(req)));
      }
      default:
        return fail(404, E_METHOD_NOT_FOUND, `Method not found: ${msg.method}`);
    }
  }

  /** 2025-03-26 ~ 2025-11-25 的握手协议;不发会话 id,每个请求照样独立处理 */
  async function legacy(req: Request, msg: any): Promise<Reply | null> {
    const id = msg.id;
    // 通知和客户端发来的响应:收下,不回内容
    if (id === undefined || msg.method === undefined) return null;
    switch (msg.method) {
      case 'initialize': {
        const asked = msg.params?.protocolVersion;
        return { status: 200, body: rpcResult(id, { protocolVersion: LEGACY_VERSIONS.includes(asked) ? asked : LEGACY_VERSIONS[0], capabilities: { tools: {} }, serverInfo, instructions: INSTRUCTIONS }) };
      }
      case 'ping':
        return { status: 200, body: rpcResult(id, {}) };
      case 'tools/list':
        return { status: 200, body: rpcResult(id, { tools: toolList() }) };
      case 'tools/call': {
        const name = msg.params?.name;
        if (!hasTool(name)) return { status: 200, body: rpcError(id, E_INVALID_PARAMS, `Unknown tool: ${name}`) };
        return { status: 200, body: rpcResult(id, await callTool(name, msg.params?.arguments, toolContext(req))) };
      }
      default:
        return { status: 200, body: rpcError(id, E_METHOD_NOT_FOUND, `Method not found: ${msg.method}`) };
    }
  }

  const validMessage = (m: any) => m && typeof m === 'object' && !Array.isArray(m) && m.jsonrpc === '2.0' && (typeof m.method === 'string' || m.id !== undefined);

  r.post('/mcp', express.json({ limit: '1mb', type: () => true }), async (req: Request, res: Response) => {
    const body = req.body;
    try {
      // 2025-03-26 允许一次发一组;握手协议的才这么干
      if (Array.isArray(body)) {
        if (!body.length || !body.every(validMessage)) return void res.status(400).json(rpcError(null, E_INVALID_REQUEST, 'Invalid Request'));
        const replies = (await Promise.all(body.map((m) => legacy(req, m)))).filter((x): x is Reply => x !== null);
        return void (replies.length ? res.json(replies.map((x) => x.body)) : res.status(202).end());
      }
      if (!validMessage(body)) return void res.status(400).json(rpcError(null, E_INVALID_REQUEST, 'Invalid Request'));
      // 哪一代:正文 _meta 里带版本的是新协议;initialize 一定是握手协议;其余看头里的版本
      const metaVersion = body.params?._meta?.[META_VERSION];
      const headerVersion = req.get('mcp-protocol-version');
      const isModern = body.method !== 'initialize' && (typeof metaVersion === 'string' || (headerVersion !== undefined && !LEGACY_VERSIONS.includes(headerVersion) && headerVersion !== '2024-11-05'));
      const reply = isModern ? await modern(req, body, typeof metaVersion === 'string' ? metaVersion : headerVersion!) : await legacy(req, body);
      if (!reply || reply.body === undefined) return void res.status(reply?.status ?? 202).end();
      res.status(reply.status).json(reply.body);
    } catch (e) {
      console.error(e);
      if (!res.headersSent) res.status(500).json(rpcError(body?.id, -32603, 'Internal error'));
    }
  });

  // 正文不是 JSON
  r.use('/mcp', (err: unknown, _req: Request, res: Response, next: (e?: unknown) => void) => {
    if (res.headersSent) return next(err);
    res.status(400).json(rpcError(null, E_PARSE, 'Parse error'));
  });

  return r;
}
