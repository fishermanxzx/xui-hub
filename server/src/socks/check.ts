// SOCKS5 连通性测试:握手认证 → 经代理访问 Cloudflare trace(HTTPS),拿到出口 IP 和地区。
// 从本服务所在机器发起;代理商若按来源 IP 白名单放行,结果可能与中转机上不同。

import { once } from 'node:events';
import { createConnection, type Socket } from 'node:net';
import { performance } from 'node:perf_hooks';
import { connect as connectTls } from 'node:tls';
import type { SocksCheck, SocksEndpoint } from './repo';

const TARGET_HOST = 'www.cloudflare.com';
const TARGET_PATH = '/cdn-cgi/trace';

/** 精确读取 n 个字节(TCP 分包、粘包都能处理) */
function readBytes(socket: Socket, size: number, signal: AbortSignal): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    function cleanup() {
      socket.off('readable', read);
      socket.off('error', fail);
      socket.off('end', closed);
      socket.off('close', closed);
      signal.removeEventListener('abort', aborted);
    }
    function fail(error: Error) {
      cleanup();
      reject(error);
    }
    function closed() {
      fail(new Error('连接被代理关闭'));
    }
    function aborted() {
      fail(signal.reason);
    }
    function read() {
      const data = socket.read(size) as Buffer | null;
      if (data) {
        cleanup();
        resolve(data);
      } else if (socket.destroyed || socket.readableEnded) closed();
    }
    socket.on('readable', read);
    socket.on('error', fail);
    socket.on('end', closed);
    socket.on('close', closed);
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted();
    else read();
  });
}

const CONNECT_ERRORS: Record<number, string> = {
  1: '代理内部错误',
  2: '代理规则禁止访问',
  3: '代理网络不可达',
  4: '目标主机不可达',
  5: '目标拒绝连接',
  6: '连接超时',
  7: '代理不支持 CONNECT',
  8: '代理不支持域名地址',
};

async function socks5Connect(socket: Socket, ep: SocksEndpoint, host: string, port: number, signal: AbortSignal): Promise<void> {
  const user = Buffer.from(ep.username);
  const pass = Buffer.from(ep.password);
  const withAuth = user.length > 0 || pass.length > 0;
  socket.write(Buffer.from(withAuth ? [5, 2, 0, 2] : [5, 1, 0]));
  const method = await readBytes(socket, 2, signal);
  if (method[0] !== 5) throw new Error('不是 SOCKS5 代理');
  if (method[1] === 0xff) throw new Error('代理不接受这种认证方式,检查用户名密码');
  if (method[1] === 2) {
    if (!withAuth) throw new Error('代理要求用户名密码');
    socket.write(Buffer.concat([Buffer.from([1, user.length]), user, Buffer.from([pass.length]), pass]));
    const auth = await readBytes(socket, 2, signal);
    if (auth[1] !== 0) throw new Error('用户名或密码错误');
  } else if (method[1] !== 0) {
    throw new Error(`代理要求不支持的认证方式(${method[1]})`);
  }
  // 目标用域名,由代理解析(与面板出站一致)
  const name = Buffer.from(host);
  const portBuf = Buffer.alloc(2);
  portBuf.writeUInt16BE(port);
  socket.write(Buffer.concat([Buffer.from([5, 1, 0, 3, name.length]), name, portBuf]));
  const reply = await readBytes(socket, 4, signal);
  if (reply[0] !== 5) throw new Error('代理返回了无效的响应');
  if (reply[1] !== 0) throw new Error(CONNECT_ERRORS[reply[1]] ?? `代理连接目标失败(${reply[1]})`);
  const addrLen = reply[3] === 1 ? 4 : reply[3] === 4 ? 16 : reply[3] === 3 ? (await readBytes(socket, 1, signal))[0] : -1;
  if (addrLen < 0) throw new Error('代理返回了无效的绑定地址');
  await readBytes(socket, addrLen + 2, signal);
}

/** 解析 Cloudflare trace 的 ip= / loc= */
export function parseTrace(text: string): { ip: string | null; loc: string | null } {
  return { ip: text.match(/^ip=(\S+)/m)?.[1] ?? null, loc: text.match(/^loc=(\S+)/m)?.[1] ?? null };
}

export async function checkSocks(ep: SocksEndpoint, timeoutMs = 10_000): Promise<SocksCheck> {
  const started = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`超时(${timeoutMs / 1000} 秒)`)), timeoutMs);
  let socket: Socket | undefined;
  let stage = '连接代理';
  const done = (fields: Partial<SocksCheck>): SocksCheck => ({
    at: Date.now(),
    ok: false,
    ms: Math.round(performance.now() - started),
    ip: null,
    loc: null,
    error: null,
    ...fields,
  });
  try {
    socket = createConnection({ host: ep.host, port: ep.port, signal: controller.signal });
    socket.on('error', () => {});
    await once(socket, 'connect', { signal: controller.signal });
    stage = 'SOCKS 握手';
    await socks5Connect(socket, ep, TARGET_HOST, 443, controller.signal);
    stage = '经代理访问 HTTPS';
    const tls = connectTls({ socket, servername: TARGET_HOST });
    tls.on('error', () => {});
    // 超时时断开,下面读响应的循环随之结束
    controller.signal.addEventListener('abort', () => tls.destroy(controller.signal.reason), { once: true });
    await once(tls, 'secureConnect', { signal: controller.signal });
    // 用 write 而不是 end:先半关闭写端,有的服务器会直接断开不回响应
    tls.write(`GET ${TARGET_PATH} HTTP/1.1\r\nHost: ${TARGET_HOST}\r\nUser-Agent: xui-hub\r\nConnection: close\r\n\r\n`);
    let text = '';
    tls.setEncoding('utf8');
    for await (const chunk of tls) {
      text += chunk;
      if (text.length > 64 * 1024) break;
    }
    const status = Number(text.match(/^HTTP\/1\.[01] (\d{3})/)?.[1]);
    if (status !== 200) throw new Error(status ? `HTTP ${status}` : `没有收到有效的 HTTP 响应(${text.length} 字节)`);
    return done({ ok: true, ...parseTrace(text) });
  } catch (e: any) {
    const reason = controller.signal.aborted
      ? controller.signal.reason.message
      : (({ ECONNREFUSED: '连接被拒绝', ENOTFOUND: '代理域名无法解析', ECONNRESET: '连接被重置', ETIMEDOUT: '连接超时' }) as Record<string, string>)[
          e?.code
        ] ?? e?.message ?? String(e);
    return done({ error: `${stage}失败:${reason}` });
  } finally {
    clearTimeout(timer);
    socket?.destroy();
  }
}
