import assert from 'node:assert/strict';
import { test } from 'node:test';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { addLine, createCustomer, getCustomer, resetSubToken, setLineName, updateCustomer, updateLineStats } from '../customers/repo';
import type { Converter } from '../subscription/convert';
import { listSubFetches, pruneSubFetches } from '../subscription/fetchLog';
import type { LinkFetcher } from '../subscription/service';
import { HOP_HEADER, type UpstreamFetcher } from '../subscription/upstream';
import { templateUrl } from '../subscription/templates';
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
const CONFIG = templateUrl('');

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
  upstreamFetcher?: UpstreamFetcher,
) {
  const deps: SubscriptionDeps = { db, fetcher: linkFetcher, convert, internalBaseUrl: '', internalSecret: 'internal-secret', mihomoTemplate, upstreamFetcher };
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
    assert.equal(res.headers.get('profile-update-interval'), '1');
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

test('自定义节点名:订阅里换成线路自己的名字,没设的照旧', async () => {
  const { db, id, token } = setup();
  const lines = getCustomer(db, id)!.lines;
  setLineName(db, lines[0].id, '香港 01');
  const { link, close } = await serve(db, fakeConverter([]));
  try {
    assert.equal(await decode(await get(link(token), V2RAYN_UA)), 'vless://x@1.1.1.1:1#%E9%A6%99%E6%B8%AF%2001\nhysteria2://y@2.2.2.2:2#B');
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

test('自定义链接:和生成的链接回一样的内容(格式、流量头、拉取记录、自助页);对不上的放给后面的路由;重置 token 不影响', async () => {
  const { db, id, other, token } = setup();
  updateCustomer(db, id, { sub_links: ['/getprofile?name=profiles/zhu&token=t', '/s/zhu'] });
  const calls: Call[] = [];
  const { base, link, close } = await serve(db, fakeConverter(calls));
  try {
    const viaToken = await get(link(token), CLASH_UA);
    const viaLink = await get(`${base}/getprofile?token=t&name=profiles%2Fzhu`, CLASH_UA);
    assert.equal(viaLink.status, 200);
    assert.equal(await viaLink.text(), await viaToken.text());
    assert.equal(viaLink.headers.get('subscription-userinfo'), USERINFO);
    assert.equal(viaLink.headers.get('content-type'), viaToken.headers.get('content-type'));
    // 多带参数照样认,?target= 照样能指定格式
    assert.equal(await decode(await get(`${base}/S/zhu/?target=base64`, CLASH_UA)), NODES);
    assert.equal((await fetch(`${base}/s/zhu`, { method: 'HEAD', headers: { 'User-Agent': V2RAYN_UA } })).status, 200);
    // 拉取记录照常记在这位客户名下
    assert.equal(listSubFetches(db, id).length, 4);
    // 浏览器打开:自助页,上面给的是生成的链接
    const page = await fetch(`${base}/s/zhu`, { headers: { 'User-Agent': BROWSER_UA, Accept: 'text/html' } });
    assert.match(await page.text(), new RegExp(`/sub/${token}`));
    // 路径配过、参数不全:404(token 写错一样);没配过的路径不归这里管,落到后面的路由
    const wrong = await get(`${base}/getprofile?name=profiles/zhu`, CLASH_UA);
    assert.deepEqual([wrong.status, await wrong.text()], [404, 'not found']);
    assert.equal(listSubFetches(db, id).length, 4, '对不上的不记');
    const app = express();
    app.use(subscriptionRouter({ db, fetcher, convert: null, internalBaseUrl: '', internalSecret: '', mihomoTemplate: () => false }));
    app.use((_req, res) => void res.send('next'));
    const server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    try {
      const b2 = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      assert.equal(await (await get(`${b2}/s/nobody`, CLASH_UA)).text(), 'next');
      assert.equal(await (await get(`${b2}/`, CLASH_UA)).text(), 'next');
      assert.equal(await (await get(`${b2}/s/zhu`, V2RAYN_UA)).status, 200);
    } finally {
      await new Promise((r) => server.close(r));
    }
    // 重置 token 后自定义链接照样能用;改到别的客户名下就跟着走
    resetSubToken(db, id);
    assert.equal((await get(`${base}/s/zhu`, V2RAYN_UA)).status, 200);
    updateCustomer(db, id, { sub_links: [] });
    updateCustomer(db, other, { sub_links: ['/s/zhu'] });
    assert.equal(await decode(await get(`${base}/s/zhu`, V2RAYN_UA)), 'vless://x@1.1.1.1:1#A');
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
      assert.equal(res.headers.get('profile-update-interval'), '1');
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

test('REALITY 的 support-x25519mlkem768:Clash Verge 补上,Shadowrocket 和 Stash 不加', async () => {
  const { db, token } = setup();
  const yaml = 'proxies:\n  - {name: r, server: 1.2.3.4, port: 443, type: vless, uuid: u, reality-opts: {public-key: pk, short-id: ab}, client-fingerprint: chrome}\n';
  const { link, close } = await serve(db, async () => ({ body: yaml }));
  try {
    assert.match(await (await get(link(token), CLASH_UA)).text(), /reality-opts: \{public-key: pk, short-id: ab, support-x25519mlkem768: true\}/);
    for (const ua of [ROCKET_UA, 'Stash/2.4.0 Clash/1.9.0']) {
      const body = await (await get(link(token), ua)).text();
      assert.match(body, /reality-opts: \{public-key: pk, short-id: ab\}/, ua);
      assert.doesNotMatch(body, /mlkem/, ua);
    }
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

test('Mihomo 模板:只对开启的客户、只对 Clash 格式生效;Stash 用同一份头部', async () => {
  const { db, token, otherToken } = setup();
  const yaml: Converter = async (target) => ({ body: target === 'clash' ? 'port: 7890\nproxies:\n  - {name: A}\nrules:\n  - MATCH,A\n' : 'other' });
  const { link, close } = await serve(db, yaml, (name) => name === '朱先生');
  try {
    const on = await (await get(link(token), CLASH_UA)).text();
    assert.match(on, /^mixed-port: 7890\nallow-lan: false\nmode: rule\n/);
    assert.ok(!/^port:/m.test(on));
    assert.match(on, /proxies:\n  - \{name: A\}\nrules:\n  - MATCH,A\n$/);
    const stash = await (await get(link(token), 'Stash/2.7.6 Clash/1.11.0')).text();
    assert.equal(stash, on);
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

test('设备数上限:名额内的设备登记放行,满了新设备 403;自助页列出设备,移除一台后新设备能拉;同客户端升级版本不占新名额', async () => {
  const { db, id, token, otherToken } = setup();
  const { link, close } = await serve(db, fakeConverter([]));
  const { listDevices, pruneDevices, DEVICE_IDLE_DAYS } = await import('../subscription/devices');
  const page = (t = token) => fetch(link(t), { headers: { 'User-Agent': BROWSER_UA, Accept: 'text/html' } }).then((r) => r.text());
  try {
    // 没设上限:随便拉,设备照样登记
    for (const ua of [CLASH_UA, CLASH_UA, V2RAYN_UA]) assert.equal((await get(link(token), ua)).status, 200);
    assert.deepEqual(listDevices(db, id).map((d) => d.ua).sort(), [CLASH_UA, V2RAYN_UA]);
    // 浏览器看自助页不算设备
    assert.match(await page(), /2 台,不限/);
    assert.equal(listDevices(db, id).length, 2);

    // 上限 2:已有的两台照常,第三台被拒,记录里是 403
    updateCustomer(db, id, { limit_devices: 2 });
    assert.equal((await get(link(token), CLASH_UA)).status, 200);
    const blocked = await get(link(token), SING_UA);
    assert.equal(blocked.status, 403);
    assert.match(await blocked.text(), /device limit reached/);
    assert.equal(listDevices(db, id).length, 2);
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(listSubFetches(db, id).filter((f) => f.ua === SING_UA).map((f) => f.status), [403]);
    // 别的客户不受影响
    assert.equal((await get(link(otherToken), SING_UA)).status, 200);

    // 同一个客户端升级了版本(同 IP):顶替原来那台,不占新名额
    assert.equal((await get(link(token), 'clash-verge/v2.4.0')).status, 200);
    assert.deepEqual(listDevices(db, id).map((d) => d.ua).sort(), ['clash-verge/v2.4.0', V2RAYN_UA]);

    // 自助页:2 / 2,提示已满;移除一台(凭 token),新设备就能拉了
    const html = await page();
    assert.match(html, /2 \/ 2 台/);
    assert.match(html, /设备数已到上限/);
    const victim = listDevices(db, id).find((d) => d.ua === V2RAYN_UA)!;
    assert.ok(html.includes(`/sub/${token}/devices/${victim.id}/delete`));
    // 拿别人的 token 删不掉
    await fetch(`${link(otherToken)}/devices/${victim.id}/delete`, { method: 'POST', redirect: 'manual' });
    assert.equal(listDevices(db, id).length, 2);
    const del = await fetch(`${link(token)}/devices/${victim.id}/delete`, { method: 'POST', redirect: 'manual' });
    assert.deepEqual([del.status, del.headers.get('location')], [303, `../../../${token}?removed=1`]);
    assert.equal((await fetch(`${link('bad')}/devices/1/delete`, { method: 'POST', redirect: 'manual' })).status, 404);
    assert.equal((await get(link(token), SING_UA)).status, 200);
    assert.equal((await get(link(token), V2RAYN_UA)).status, 403);

    // 带 x-hwid 的客户端按它认设备:UA 变了也是同一台
    updateCustomer(db, id, { limit_devices: 3 });
    const hw = (ua: string, hwid: string) => fetch(link(token), { headers: { 'User-Agent': ua, 'x-hwid': hwid } });
    assert.deepEqual([(await hw('Happ/1.0', 'abc')).status, (await hw('Happ/2.0', 'abc')).status, (await hw('Happ/2.0', 'xyz')).status], [200, 200, 403]);

    // 30 天没再拉过的设备自动清掉
    assert.equal(listDevices(db, id).length, 3);
    pruneDevices(db, Date.now() + (DEVICE_IDLE_DAYS + 1) * 86_400_000);
    assert.equal(listDevices(db, id).length, 0);
    assert.equal(updateCustomer(db, id, { limit_devices: 0 }), undefined);
    assert.throws(() => updateCustomer(db, id, { limit_devices: 101 }), /设备数上限/);
  } finally {
    await close();
  }
});

// ---------- 外部订阅 ----------

const UP_URL = 'https://sub.example.com/sub/reseller-token';
const UP_LINK = 'vless://up@203.0.113.20:443?encryption=none&flow=xtls-rprx-vision&security=reality&sni=www.example.com&fp=chrome&pbk=PK&sid=ab&type=tcp#reseller';
const UP_INFO = 'upload=10; download=20; total=3000; expire=4102444800';

/** 假的外部订阅:按 v2rayN 回 base64 节点和流量头;记下每次请求 */
function upstream(calls: string[], reply: () => { status: number; body: string; userinfo: string | null } = () => ({ status: 200, body: Buffer.from(`${UP_LINK}\n`).toString('base64'), userinfo: UP_INFO })): UpstreamFetcher {
  return async (url) => {
    calls.push(url);
    return reply();
  };
}

/** 假的 subconverter:把 vless 链接写成 Clash 单行节点(带 reality-opts),用来看 mlkem 的处理 */
const yamlConverter: Converter = async (_target, source) => {
  const links = Buffer.from(await (await fetch(source)).text(), 'base64').toString().split('\r\n').filter(Boolean);
  const rows = links.map((l) => {
    const u = new URL(l);
    const q = u.searchParams;
    return `  - {name: ${decodeURIComponent(u.hash.slice(1))}, server: ${u.hostname}, port: ${u.port}, type: ${u.protocol.slice(0, -1)}${q.get('pbk') ? `, reality-opts: {public-key: ${q.get('pbk')}, short-id: ${q.get('sid')}}` : ''}}`;
  });
  return { body: `proxies:\n${rows.join('\n')}\n` };
};

test('外部订阅(合并):每种格式都带上外部的节点;流量头默认用客户自己的,开了透传用外部的', async () => {
  const { db, id, token } = setup();
  updateCustomer(db, id, { upstreams: [UP_URL] });
  const calls: string[] = [];
  const conv: Call[] = [];
  const { link, close } = await serve(db, fakeConverter(conv), () => false, fetcher, upstream(calls));
  try {
    const b64 = await get(link(token), V2RAYN_UA);
    assert.equal(await decode(b64), `${NODES}\n${UP_LINK}`);
    assert.equal(b64.headers.get('subscription-userinfo'), USERINFO);
    // 60 秒内不重复取;Clash 经 subconverter 回源也是同一份
    const clash = await (await get(link(token), CLASH_UA)).text();
    assert.ok(clash.endsWith(`${NODES}\n${UP_LINK}`));
    assert.equal(calls.length, 1);
    const sing = JSON.parse(await (await get(link(token), SING_UA)).text());
    const out = sing.outbounds.find((o: any) => o.tag === 'reseller');
    assert.deepEqual([out.type, out.flow, out.tls.reality.public_key, out.tls.reality.short_id, out.tls.utls.fingerprint], ['vless', 'xtls-rprx-vision', 'PK', 'ab', 'chrome']);
    assert.ok(Buffer.from(await (await get(link(token), 'Quantumult X/1.0')).text(), 'base64').toString().includes('reality-base64-pubkey=PK'));
    assert.ok((await (await get(link(token), 'Loon/3.2')).text()).includes('reseller=VLESS,203.0.113.20,443'));
    assert.deepEqual(calls, [UP_URL]);

    updateCustomer(db, id, { upstream_userinfo: true });
    for (const ua of [V2RAYN_UA, CLASH_UA, SING_UA]) assert.equal((await get(link(token), ua)).headers.get('subscription-userinfo'), UP_INFO, ua);
  } finally {
    await close();
  }
});

test('外部订阅(只给外部的):不去取自己线路的节点;外部的 REALITY 节点照样按客户端补 / 不补 mlkem', async () => {
  const { db, id, token } = setup();
  updateCustomer(db, id, { upstreams: [UP_URL], upstream_mode: 'replace' });
  const panels: LinkFetcher = async () => {
    throw new Error('不该去取面板');
  };
  const { link, close } = await serve(db, yamlConverter, () => false, panels, upstream([]));
  try {
    assert.equal(await decode(await get(link(token), V2RAYN_UA)), UP_LINK);
    assert.match(await (await get(link(token), CLASH_UA)).text(), /name: reseller, .*reality-opts: \{public-key: PK, short-id: ab, support-x25519mlkem768: true\}/);
    const rocket = await (await get(link(token), ROCKET_UA)).text();
    assert.match(rocket, /reality-opts: \{public-key: PK, short-id: ab\}/);
    assert.doesNotMatch(rocket, /mlkem/);
  } finally {
    await close();
  }
});

test('外部订阅:取不到时用上次的;从没取到过且只给外部的 → 502;别处 xui-hub 来拉(带标记头)只给自己线路的', async () => {
  const { db, id, token } = setup();
  updateCustomer(db, id, { upstreams: [UP_URL], upstream_mode: 'replace' });
  let ok = false;
  const calls: string[] = [];
  const flaky = upstream(calls, () => (ok ? { status: 200, body: UP_LINK, userinfo: null } : { status: 500, body: 'oops', userinfo: null }));
  const { link, close } = await serve(db, fakeConverter([]), () => false, fetcher, flaky);
  try {
    assert.equal((await get(link(token), V2RAYN_UA)).status, 502);
    ok = true;
    db.prepare('UPDATE upstream_subs SET tried_at = 0').run();
    assert.equal(await decode(await get(link(token), V2RAYN_UA)), UP_LINK);
    ok = false;
    db.prepare('UPDATE upstream_subs SET tried_at = 0').run();
    assert.equal(await decode(await get(link(token), V2RAYN_UA)), UP_LINK);
    assert.equal(calls.length, 3);
    assert.match(getCustomer(db, id)!.upstreams[0].error, /HTTP 500/);

    // 带标记头:不取也不给外部的,只给自己线路的(只给外部时也一样)
    db.prepare('UPDATE upstream_subs SET tried_at = 0').run();
    const hop = await fetch(link(token), { headers: { 'User-Agent': V2RAYN_UA, [HOP_HEADER]: '1' } });
    assert.equal(await decode(hop), NODES);
    const hopClash = await fetch(link(token), { headers: { 'User-Agent': CLASH_UA, [HOP_HEADER]: '1' } });
    assert.ok((await hopClash.text()).endsWith(`|${NODES}`));
    assert.equal(calls.length, 3);
  } finally {
    await close();
  }
});

test('外部订阅:客户到期 / 超额时不去取,也不出节点', async () => {
  const { db, id, token } = setup();
  updateCustomer(db, id, { upstreams: [UP_URL], upstream_mode: 'replace', expire_at: 1 });
  const calls: string[] = [];
  const { link, close } = await serve(db, fakeConverter([]), () => false, fetcher, upstream(calls));
  try {
    assert.equal(await (await get(link(token), V2RAYN_UA)).text(), '');
    assert.equal((await get(link(token), CLASH_UA)).status, 403);
    assert.equal((await get(link(token), BROWSER_UA)).status, 200);
    assert.deepEqual(calls, []);
  } finally {
    await close();
  }
});

test('自助页:列出外部订阅的节点数,不露地址;开了透传时流量和到期显示外部的', async () => {
  const { db, id, token } = setup();
  updateCustomer(db, id, { upstreams: [UP_URL] });
  const { link, close } = await serve(db, fakeConverter([]), () => false, fetcher, upstream([]));
  const page = async () => (await fetch(link(token), { headers: { 'User-Agent': BROWSER_UA, Accept: 'text/html' } })).text();
  try {
    let html = await page();
    assert.match(html, /2 条线路 \+ 1 个外部节点/);
    assert.match(html, /外部订阅<\/span><span class="muted">1 个节点/);
    assert.ok(!html.includes('sub.example.com') && !html.includes('reseller-token'));
    assert.match(html, /已用 0 KB \/ 1 KB/);

    updateCustomer(db, id, { upstream_userinfo: true, upstream_mode: 'replace' });
    html = await page();
    assert.match(html, /已用 0 KB \/ 3 KB/);
    assert.match(html, /到期:2100-01-01/);
    assert.match(html, /<div class="muted">1 个节点 · /);
  } finally {
    await close();
  }
});

test('外部订阅:只要节点,分组和规则用本系统的(Clash 模板、sing-box 配置);节点名可以改', async () => {
  const { db, id, token } = setup();
  updateCustomer(db, id, { upstreams: [{ url: UP_URL, node_name: '美国家宽' }], upstream_mode: 'replace', sub_template: 'ACL4SSR_Online_Full' });
  const theirs = `proxy-groups:
  - {name: 上游的分组, type: select, proxies: [reseller]}
rules:
  - DOMAIN-SUFFIX,upstream-rule.example,上游的分组
proxies:
  - {name: reseller, type: vless, server: 203.0.113.20, port: 443, uuid: up, tls: true, flow: xtls-rprx-vision, reality-opts: {public-key: PK, short-id: ab}}
`;
  const conv: Call[] = [];
  const { link, close } = await serve(db, fakeConverter(conv), () => false, fetcher, upstream([], () => ({ status: 200, body: theirs, userinfo: null })));
  try {
    const clash = await (await get(link(token), CLASH_UA)).text();
    // subconverter 拿到的是本系统的模板,节点源只有节点链接
    assert.equal(conv[0].options.config, templateUrl('ACL4SSR_Online_Full'));
    assert.doesNotMatch(clash, /upstream-rule|上游的分组/);
    assert.match(clash, /#%E7%BE%8E%E5%9B%BD%E5%AE%B6%E5%AE%BD$/);
    const sing = JSON.parse(await (await get(link(token), SING_UA)).text());
    assert.deepEqual(sing.outbounds.find((o: any) => o.type === 'selector').outbounds, ['自动选择', '美国家宽']);
    assert.doesNotMatch(JSON.stringify(sing), /upstream-rule|上游的分组/);
    assert.match(await decode(await get(link(token), V2RAYN_UA)), /^vless:\/\/up@203\.0\.113\.20:443\?.*#%E7%BE%8E%E5%9B%BD%E5%AE%B6%E5%AE%BD$/);
  } finally {
    await close();
  }
});
