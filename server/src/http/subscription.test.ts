import assert from 'node:assert/strict';
import { test } from 'node:test';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { addLine, createCustomer, getCustomer, resetSubToken, updateCustomer, updateLineStats } from '../customers/repo';
import type { Converter } from '../subscription/convert';
import { listSubFetches, pruneSubFetches } from '../subscription/fetchLog';
import { DEFAULT_CONVERT_OPTIONS } from '../subscription/format';
import type { LinkFetcher } from '../subscription/service';
import { addPanel, memoryDb } from '../testUtil';
import { subscriptionRouter, type SubscriptionDeps } from './subscription';

const CLASH_UA = 'clash-verge/v2.2.3';
const SING_UA = 'SFA/1.11.0 (sing-box 1.11.0)';
const HIDDIFY_UA = 'HiddifyNext/2.5.7 (android) like ClashMeta v2rayNG v2rayN';
const ROCKET_UA = 'Shadowrocket/2070 CFNetwork/1568 Darwin/24.0.0';
const V2RAYN_UA = 'v2rayN/7.10.5';
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15';
const NODES = 'vless://x@1.1.1.1:1#A\nhysteria2://y@2.2.2.2:2#B';
const USERINFO = 'upload=0; download=0; total=1000; expire=4102444800';
const CONFIG = DEFAULT_CONVERT_OPTIONS.config;

const fetcher: LinkFetcher = async (panel) => (panel.name === 'a' ? ['vless://x@1.1.1.1:1#A'] : ['hysteria2://y@2.2.2.2:2#B']);

function setup() {
  const db = memoryDb();
  const a = addPanel(db, 'a');
  const b = addPanel(db, 'b');
  const id = createCustomer(db, { name: '朱先生', quota_bytes: 1000, expire_at: 4_102_444_800_000 });
  const line = (customer_id: number, panel_id: number, email: string) =>
    addLine(db, { customer_id, kind: 'direct', panel_id, inbound_id: 1, inbound_remark: 'r', protocol: 'vless', email });
  line(id, a.id, 'zhu');
  line(id, b.id, 'zhu');
  const other = createCustomer(db, { name: 'newbie' });
  line(other, a.id, 'newbie');
  const token = getCustomer(db, id)!.sub_token;
  return { db, id, other, token, otherToken: getCustomer(db, other)!.sub_token };
}

type Call = { target: string; source: string; options: Record<string, string> };

/** 假的 subconverter:回源取原始节点(验证内部通道),返回 目标格式|config|节点 */
function fakeConverter(calls: Call[]): Converter {
  return async (target, source, options) => {
    calls.push({ target, source, options });
    // 与真的 subconverter 一样:回源失败就转换失败
    const res = await fetch(source);
    if (!res.ok) throw new Error(`回源 ${res.status}`);
    return { body: `${target}|${options.config ?? ''}|${await decode(res)}` };
  };
}

async function serve(
  db: ReturnType<typeof memoryDb>,
  convert: Converter | null,
  mihomoTemplate: (name: string) => boolean = () => false,
  linkFetcher: LinkFetcher = fetcher,
) {
  const deps: SubscriptionDeps = { db, fetcher: linkFetcher, convert, internalBaseUrl: '', internalSecret: 'internal-secret', mihomoTemplate };
  const app = express();
  app.use(subscriptionRouter(deps));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  deps.internalBaseUrl = base;
  const link = (token: string) => `${base}/sub/${token}`;
  return { base, link, close: () => new Promise((r) => server.close(r)) };
}

const get = (url: string, ua?: string) => fetch(url, { headers: ua ? { 'User-Agent': ua } : {} });
/** base64 订阅解码;行尾是 CRLF、末尾带换行,这里还原成 \n 分隔便于比较 */
const decode = async (res: Response) => Buffer.from(await res.text(), 'base64').toString().replace(/\r\n$/, '').split('\r\n').join('\n');

test('Clash:text/yaml,带文件名、更新间隔、全局流量;默认转换参数;token 不对 404', async () => {
  const { db, id, token } = setup();
  const calls: Call[] = [];
  const { link, close } = await serve(db, fakeConverter(calls));
  try {
    assert.equal((await get(link('bad-token'))).status, 404);

    const res = await get(link(token), CLASH_UA);
    assert.equal(await res.text(), `clash|${CONFIG}|${NODES}`);
    assert.match(CONFIG, /ACL4SSR_Online_Mini\.ini$/);
    assert.equal(res.headers.get('content-type'), 'text/yaml; charset=utf-8');
    assert.equal(res.headers.get('content-disposition'), `attachment;filename*=UTF-8''${encodeURIComponent('朱先生')}`);
    assert.equal(res.headers.get('profile-update-interval'), '24');
    assert.equal(res.headers.get('subscription-userinfo'), USERINFO);
    assert.equal(calls[0].options.emoji, 'true');
    assert.match(calls[0].source, /\/internal\/nodes\/\d+\?key=internal-secret$/);
    assert.ok(getCustomer(db, id)!.sub_fetched_at);
    assert.equal(getCustomer(db, id)!.sub_fetched_ua, CLASH_UA);
    // 认不出的非浏览器 UA 给 Clash;?target= 优先
    assert.match(await (await get(link(token), 'curl/8.0')).text(), /^clash\|/);
    assert.equal(await decode(await get(link(token) + '?target=base64', CLASH_UA)), NODES);
  } finally {
    await close();
  }
});

test('重置订阅链接后旧 token 404,新 token 可用', async () => {
  const { db, id, token } = setup();
  const { link, close } = await serve(db, fakeConverter([]));
  try {
    assert.equal((await get(link(token), V2RAYN_UA)).status, 200);
    resetSubToken(db, id);
    assert.equal((await get(link(token), V2RAYN_UA)).status, 404);
    assert.equal(await decode(await get(link(getCustomer(db, id)!.sub_token), V2RAYN_UA)), NODES);
  } finally {
    await close();
  }
});

test('sing-box 与 Hiddify:本系统生成 JSON(不经 subconverter),Profile-Title,不带下载头;按版本选 DNS 写法', async () => {
  const { db, token } = setup();
  const calls: Call[] = [];
  const { link, close } = await serve(db, fakeConverter(calls));
  try {
    for (const [ua, legacy] of [[SING_UA, true], [HIDDIFY_UA, false]] as const) {
      const res = await get(link(token), ua);
      const cfg = JSON.parse(await res.text());
      assert.equal(res.headers.get('content-type'), 'application/json');
      assert.equal(res.headers.get('profile-title'), `base64:${Buffer.from('朱先生').toString('base64')}`);
      assert.equal(res.headers.get('content-disposition'), null);
      assert.equal(res.headers.get('subscription-userinfo'), USERINFO);
      assert.deepEqual(cfg.outbounds.slice(3).map((o: any) => [o.type, o.tag]), [['vless', 'A'], ['hysteria2', 'B']]);
      assert.equal('address' in cfg.dns.servers[0], legacy);
    }
    assert.equal(calls.length, 0);
  } finally {
    await close();
  }
});

test('Quantumult X / Loon:本系统生成节点列表', async () => {
  const { db, token } = setup();
  const calls: Call[] = [];
  const { link, close } = await serve(db, fakeConverter(calls));
  try {
    const qx = await get(link(token), 'Quantumult%20X/1.4.1');
    assert.match(Buffer.from(await qx.text(), 'base64').toString(), /^vless=1\.1\.1\.1:1,method=none,password=x,.*tag=A\r\n$/);
    const loon = await (await get(link(token), 'Loon/774 CFNetwork/1568')).text();
    assert.match(loon, /^A=VLESS,1\.1\.1\.1,1,x,.*\r\nB=Hysteria2,2\.2\.2\.2,2,y,.*\r\n$/);
    assert.equal(calls.length, 0);
  } finally {
    await close();
  }
});

test('v2rayN 与浏览器:base64 节点,纯文本,不带下载头', async () => {
  const { db, token } = setup();
  const { link, close } = await serve(db, fakeConverter([]));
  try {
    for (const ua of [V2RAYN_UA, BROWSER_UA]) {
      const res = await get(link(token), ua);
      assert.equal(await decode(res), NODES);
      assert.equal(res.headers.get('content-type'), 'text/plain; charset=utf-8');
      assert.equal(res.headers.get('content-disposition'), null);
      assert.equal(res.headers.get('subscription-userinfo'), USERINFO);
    }
  } finally {
    await close();
  }
});

test('Shadowrocket:给 Clash 配置并带流量头(base64 节点它解析不了)', async () => {
  const { db, token } = setup();
  const { link, close } = await serve(db, fakeConverter([]));
  try {
    const res = await get(link(token), ROCKET_UA);
    assert.equal(await res.text(), `clash|${CONFIG}|${NODES}`);
    assert.equal(res.headers.get('content-type'), 'text/yaml; charset=utf-8');
    assert.equal(res.headers.get('subscription-userinfo'), USERINFO);
  } finally {
    await close();
  }
});

test('内部回源需密钥且不计入"上次获取";到期 / 超额客户无节点、其他格式 403', async () => {
  const { db, id, token } = setup();
  const { base, link, close } = await serve(db, fakeConverter([]));
  try {
    assert.equal((await get(`${base}/internal/nodes/${id}?key=wrong`)).status, 404);
    assert.equal(await decode(await get(`${base}/internal/nodes/${id}?key=internal-secret`)), NODES);
    assert.equal(getCustomer(db, id)!.sub_fetched_at, null);

    updateCustomer(db, id, { expire_at: 1 });
    assert.equal(await (await get(link(token), V2RAYN_UA)).text(), '');
    assert.equal((await decode(await get(link(token), ROCKET_UA))).split('\n').length, 1); // 只剩 STATUS 行
    assert.equal((await get(link(token), CLASH_UA)).status, 403);
  } finally {
    await close();
  }
});

test('没有 subconverter 时非 base64 格式返回 503', async () => {
  const { db, token } = setup();
  const { link, close } = await serve(db, null);
  try {
    assert.equal((await get(link(token), CLASH_UA)).status, 503);
    assert.equal(await decode(await get(link(token), V2RAYN_UA)), NODES);
  } finally {
    await close();
  }
});

test('Mihomo 模板:只对开启的客户、只对 Clash 格式生效;Stash 只补 dns', async () => {
  const { db, token, otherToken } = setup();
  const yaml: Converter = async (target) => ({ body: target === 'clash' ? 'port: 7890\nproxies:\n  - {name: A}\nrules:\n  - MATCH,A\n' : 'other' });
  const { link, close } = await serve(db, yaml, (name) => name === '朱先生');
  try {
    const on = await (await get(link(token), CLASH_UA)).text();
    assert.match(on, /^tcp-concurrent: true\nunified-delay: true\nmixed-port: 7890\n/);
    assert.ok(!/^port:/m.test(on));
    assert.match(on, /proxies:\n  - \{name: A\}\nrules:\n  - MATCH,A\n$/);
    const stash = await (await get(link(token), 'Stash/2.7.6 Clash/1.11.0')).text();
    assert.ok(stash.includes('dns:') && !stash.includes('tcp-concurrent'));
    // 非 Clash 格式(仍经 subconverter 的 Surge)不套模板
    assert.equal(await (await get(link(token), 'Surge iOS/3270')).text(), 'other');
    // 未开启的客户不变
    assert.equal(await (await get(link(otherToken), CLASH_UA)).text(), 'port: 7890\nproxies:\n  - {name: A}\nrules:\n  - MATCH,A\n');
  } finally {
    await close();
  }
});

test('全部线路都取不到节点时返回 502(客户端保留原配置);取到一部分照常给', async () => {
  const { db, token } = setup();
  const down: LinkFetcher = async () => {
    throw new Error('连接失败');
  };
  const all = await serve(db, fakeConverter([]), () => false, down);
  try {
    assert.equal((await get(all.link(token), V2RAYN_UA)).status, 502);
    assert.equal((await get(all.link(token), 'SFA/1.12.4 (sing-box 1.12.4)')).status, 502);
    assert.equal((await get(all.link(token), 'clash-verge/v2.2.3')).status, 502);
  } finally {
    await all.close();
  }
  const half: LinkFetcher = async (panel) => {
    if (panel.name === 'a') throw new Error('连接失败');
    return ['hysteria2://y@2.2.2.2:2#B'];
  };
  const some = await serve(db, fakeConverter([]), () => false, half);
  try {
    const res = await get(some.link(token), V2RAYN_UA);
    assert.equal(res.status, 200);
    assert.equal(await decode(res), 'hysteria2://y@2.2.2.2:2#B');
  } finally {
    await some.close();
  }
});

test('拉取记录:有效 token 的请求记客户、格式、状态码、UA 和真实 IP;token 错误和内部回源不记;按天数清理', async () => {
  const { db, id, token } = setup();
  const { base, link, close } = await serve(db, fakeConverter([]));
  try {
    await (await fetch(link(token), { headers: { 'User-Agent': CLASH_UA, 'CF-Connecting-IP': '203.0.113.7' } })).text();
    await (await get(link(token), V2RAYN_UA)).text();
    await (await get(link('wrong-token'), CLASH_UA)).text();
    await (await get(`${base}/internal/nodes/${id}?key=internal-secret`)).text();
    await new Promise((r) => setTimeout(r, 50));
    const rows = db.prepare('SELECT customer_id, target, status, ua, ip FROM sub_fetches ORDER BY id').all() as any[];
    assert.deepEqual(
      rows.map((r) => [r.customer_id, r.target, r.status, r.ua]),
      [
        [id, 'clash', 200, CLASH_UA],
        [id, 'base64', 200, V2RAYN_UA],
      ],
    );
    assert.equal(rows[0].ip, '203.0.113.7');
    assert.ok(rows[1].ip);
    assert.deepEqual(listSubFetches(db, id).map((r) => r.target), ['base64', 'clash']);
    // 7 天前的删掉
    db.prepare('UPDATE sub_fetches SET at = ? WHERE target = ?').run(Date.now() - 8 * 86_400_000, 'base64');
    assert.equal(pruneSubFetches(db, 7), 1);
    assert.deepEqual(listSubFetches(db, id).map((r) => r.target), ['clash']);
  } finally {
    await close();
  }
});
