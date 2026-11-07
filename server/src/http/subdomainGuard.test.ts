import assert from 'node:assert/strict';
import { test } from 'node:test';
import express from 'express';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { subdomainGuard } from './subdomainGuard';

async function withGuard(subDomains: string[], run: (get: (path: string, host: string, extra?: Record<string, string>) => Promise<number>) => Promise<void>) {
  const app = express();
  app.set('trust proxy', ['loopback', 'uniquelocal']);
  app.use(subdomainGuard(subDomains));
  app.get('*', (req, res) => res.send('ok ' + req.path));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const port = (server.address() as AddressInfo).port;
  // fetch 会丢掉自定义 Host 头,用 http.request
  const get = (path: string, host: string, extra: Record<string, string> = {}) =>
    new Promise<number>((done, fail) => {
      request({ host: '127.0.0.1', port, path, headers: { Host: host, ...extra } }, (res) => {
        res.resume();
        done(res.statusCode ?? 0);
      })
        .on('error', fail)
        .end();
    });
  try {
    await run(get);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test('订阅域名只放行 /sub/<token>', () =>
  withGuard(['sub.example.com'], async (get) => {
    assert.equal(await get('/sub/abc', 'sub.example.com'), 200);
    assert.equal(await get('/sub/abc?target=clash', 'sub.example.com'), 200);
    assert.equal(await get('/sub', 'sub.example.com'), 404);
    assert.equal(await get('/', 'SUB.example.com'), 404);
    assert.equal(await get('/get?url=x', 'sub.example.com'), 404);
    assert.equal(await get('/api/customers', 'sub.example.com'), 404);
    assert.equal(await get('/internal/nodes/1', 'sub.example.com'), 404);
    assert.equal(await get('/', 'sub.example.com:443'), 404);
    // 伪造 X-Forwarded-Host 绕不过去
    assert.equal(await get('/', 'sub.example.com', { 'X-Forwarded-Host': 'panel.example.com' }), 404);
    // 与 Express 路由一样不区分大小写
    assert.equal(await get('/Sub/abc', 'sub.example.com'), 200);
  }));

test('其他域名(后台)不提供订阅', () =>
  withGuard(['sub.example.com'], async (get) => {
    assert.equal(await get('/sub/abc', 'panel.example.com'), 404);
    assert.equal(await get('/sub/abc', 'panel.example.com', { 'X-Forwarded-Host': 'sub.example.com' }), 404);
    // 换大小写也绕不过去
    assert.equal(await get('/SUB/abc', 'panel.example.com'), 404);
    assert.equal(await get('/', 'panel.example.com'), 200);
    assert.equal(await get('/api/session', 'panel.example.com'), 200);
    // 内部 subconverter 经 compose 内网回源取节点
    assert.equal(await get('/internal/nodes/1', 'app:8788'), 200);
  }));

test('没配置订阅域名时不区分', () =>
  withGuard([], async (get) => {
    assert.equal(await get('/sub/abc', '127.0.0.1:8788'), 200);
    assert.equal(await get('/', '127.0.0.1:8788'), 200);
  }));
