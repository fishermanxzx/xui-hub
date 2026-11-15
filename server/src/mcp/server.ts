// MCP 服务端点 POST /mcp。协议本身(握手、版本协商、消息格式、工具列表和调用的收发)用官方 SDK(@modelcontextprotocol/sdk),
// 这里只做三件事:鉴权、把工具接到 SDK 上、每个请求起一对无状态的 Server + Transport(不存会话,只回 JSON,不开 SSE 流)。
// 支持的协议版本以 SDK 为准(目前到 2025-11-25)。
// 鉴权:Authorization: Bearer 带 API 令牌(xh_…,后台「设置」里生成)或 OAuth 访问令牌(xho_…,见 oauth.ts)。
// 没带或无效回 401,WWW-Authenticate 里指向受保护资源的元数据,客户端据此走 OAuth。

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js';
import express, { Router, type Request, type Response } from 'express';
import type { DB } from '../db';
import { LoginLimiter } from '../http/auth';
import { verifyToken } from '../http/tokens';
import { baseUrlOf, resourceMetadataUrl, SCOPE, verifyAccessToken } from './oauth';
import { callTool, hasTool, INSTRUCTIONS, toolList, type ApiCall, type ToolContext } from './tools';

export interface McpDeps {
  db: DB;
  adminPassword: string;
  /** 调后台 /api 的内部通道 */
  api: ApiCall;
  version: string;
}

const rpcError = (code: number, message: string) => ({ jsonrpc: '2.0', id: null, error: { code, message } });

export function mcpRouter(deps: McpDeps): Router {
  const { db } = deps;
  const authEnabled = deps.adminPassword !== '';
  const limiter = new LoginLimiter();
  const r = Router();

  /** 一个接好工具的 SDK Server;每个请求新建一个,用完即关 */
  const newServer = (ctx: ToolContext) => {
    const server = new Server({ name: 'xui-hub', title: 'xui-hub', version: deps.version }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolList() }));
    server.setRequestHandler(CallToolRequestSchema, async (req) => {
      const { name, arguments: args } = req.params;
      if (!hasTool(name)) throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${name}`);
      return callTool(name, args, ctx);
    });
    return server;
  };

  r.use('/mcp', (req, res, next) => {
    res.set({
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Accept, Authorization, MCP-Protocol-Version, Mcp-Session-Id, Last-Event-ID',
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
    const server = newServer({ api: deps.api, baseUrl: baseUrlOf(req) });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close().catch(() => {});
      void server.close().catch(() => {});
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
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
