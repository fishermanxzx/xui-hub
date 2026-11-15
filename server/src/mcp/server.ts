// MCP 服务端点 POST /mcp。协议本身用官方 SDK v2(@modelcontextprotocol/server):createMcpHandler 一个入口同时接
// 2026-07-28 的无握手协议和 2025 年各版的握手协议(无状态:每个请求新建一个 McpServer,不存会话),
// 握手、版本协商、请求头和消息的校验、工具参数按 JSON Schema 的校验都由 SDK 做。
// 这里只做两件事:鉴权,和把 tools.ts 里的工具注册到 SDK 上。
// 鉴权:Authorization: Bearer 带 API 令牌(xh_…,后台「设置」里生成)或 OAuth 访问令牌(xho_…,见 oauth.ts)。
// 没带或无效回 401,WWW-Authenticate 里指向受保护资源的元数据,客户端据此走 OAuth。

import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, fromJsonSchema, McpServer } from '@modelcontextprotocol/server';
import express, { Router, type Request, type Response } from 'express';
import type { DB } from '../db';
import { LoginLimiter } from '../http/auth';
import { verifyToken } from '../http/tokens';
import { baseUrlOf, resourceMetadataUrl, SCOPE, verifyAccessToken } from './oauth';
import { INSTRUCTIONS, runTool, TOOLS, type ApiCall } from './tools';

export interface McpDeps {
  db: DB;
  adminPassword: string;
  /** 调后台 /api 的内部通道 */
  api: ApiCall;
  version: string;
}

/** 把这次请求看到的后台地址带给工具(拼订阅链接用);进来的同名头一律覆盖掉 */
const BASE_HEADER = 'x-xuihub-base';

const rpcError = (code: number, message: string) => ({ jsonrpc: '2.0', id: null, error: { code, message } });

export function mcpRouter(deps: McpDeps): Router {
  const { db } = deps;
  const authEnabled = deps.adminPassword !== '';
  const limiter = new LoginLimiter();
  const r = Router();

  const handler = createMcpHandler(
    (ctx) => {
      const baseUrl = ctx.requestInfo?.headers.get(BASE_HEADER) ?? '';
      const server = new McpServer({ name: 'xui-hub', title: 'xui-hub', version: deps.version }, { instructions: INSTRUCTIONS });
      for (const tool of TOOLS) {
        server.registerTool(tool.name, { title: tool.title, description: tool.description, inputSchema: fromJsonSchema(tool.inputSchema as never), annotations: tool.annotations }, (args: unknown) =>
          runTool(tool, args, { api: deps.api, baseUrl }),
        );
      }
      return server;
    },
    // 2025 年的握手协议走 SDK 的无状态兼容;响应是 JSON 还是 SSE 由 SDK 定(两种客户端都必须支持)
    { legacy: 'stateless' },
  );
  const serve = toNodeHandler(handler, { onerror: (e) => console.error(e) });

  r.use('/mcp', (req, res, next) => {
    res.set({
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Accept, Authorization, MCP-Protocol-Version, Mcp-Method, Mcp-Name, Mcp-Session-Id, Last-Event-ID',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Expose-Headers': 'WWW-Authenticate',
    });
    if (req.method === 'OPTIONS') return void res.status(204).end();
    // 没有会话、不开独立的 SSE 流:GET / DELETE 一律 405
    if (req.method !== 'POST') return void res.status(405).set('Allow', 'POST, OPTIONS').json(rpcError(-32000, 'Method not allowed: this endpoint only accepts POST'));

    if (!authEnabled) {
      // 没设后台密码(只监听本机)时不鉴权,这时要防 DNS 重绑定:浏览器带来的 Origin 必须就是这个地址
      const origin = req.get('origin');
      if (origin && origin !== baseUrlOf(req)) return void res.status(403).json(rpcError(-32000, 'Forbidden: invalid Origin'));
      return next();
    }
    const header = req.get('authorization');
    const challenge = (error?: string) => `Bearer resource_metadata="${resourceMetadataUrl(req)}", scope="${SCOPE}"${error ? `, error="${error}"` : ''}`;
    if (!header) return void res.status(401).set('WWW-Authenticate', challenge()).json(rpcError(-32000, 'Unauthorized: send an API token or an OAuth access token as a Bearer token'));
    const ip = req.ip ?? 'unknown';
    if (!limiter.allow(ip)) return void res.status(429).json(rpcError(-32000, 'Too many failed attempts, try again in 10 minutes'));
    if (verifyToken(db, header) == null && verifyAccessToken(db, header) == null) {
      limiter.fail(ip);
      return void res.status(401).set('WWW-Authenticate', challenge('invalid_token')).json(rpcError(-32000, 'Unauthorized: token is invalid or expired'));
    }
    next();
  });

  r.post('/mcp', express.json({ limit: '1mb', type: () => true }), async (req: Request, res: Response) => {
    req.headers[BASE_HEADER] = baseUrlOf(req);
    try {
      await serve(req, res as never, req.body);
    } catch (e) {
      console.error(e);
      if (!res.headersSent) res.status(500).json(rpcError(-32603, 'Internal error'));
    }
  });

  // 正文不是 JSON
  r.use('/mcp', (err: unknown, _req: Request, res: Response, next: (e?: unknown) => void) => {
    if (res.headersSent) return next(err);
    res.status(400).json(rpcError(-32700, 'Parse error'));
  });

  return r;
}
