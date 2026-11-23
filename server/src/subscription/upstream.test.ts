import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCustomer, deleteCustomer, getCustomer, updateCustomer } from '../customers/repo';
import { memoryDb } from '../testUtil';
import { cachedUpstream, parseUserinfo, refreshUpstreams, sumUserinfo, validUpstreams, type UpstreamFetcher } from './upstream';

const A = 'https://sub.example.com/api/v1/client/subscribe?token=aaa';
const B = 'https://sub2.example.com/s/bbb';
const LINK = 'vless://u@203.0.113.10:443?security=reality&pbk=K&sid=1#a';
const urls = (raw: unknown) => validUpstreams(raw).map((u) => u.url);

test('地址校验:按行或数组、去重、只认 http(s)、最多 10 个', () => {
  assert.deepEqual(urls(`${A}\n\n ${B} \n${A}`), [A, B]);
  assert.deepEqual(urls([A]), [A]);
  assert.deepEqual(urls(''), []);
  assert.throws(() => urls(['sub.example.com/x']), /http:\/\/ 或 https:\/\//);
  assert.throws(() => urls(['ftp://sub.example.com/x']), /http:\/\/ 或 https:\/\//);
  assert.throws(() => urls(Array.from({ length: 11 }, (_, i) => `https://s.example.com/${i}`)), /最多 10 个/);
});

test('subscription-userinfo:解析、几个加起来(不限的总量算不限,到期取最早)', () => {
  assert.deepEqual(parseUserinfo('upload=1; download=2; total=1.073741824E10; expire=1700000000'), { upload: 1, download: 2, total: 10737418240, expire: 1700000000 });
  assert.equal(parseUserinfo('hello'), null);
  assert.equal(parseUserinfo(null), null);
  assert.deepEqual(
    sumUserinfo([{ upload: 1, download: 2, total: 10, expire: 200 }, null, { upload: 3, download: 4, total: 20, expire: 100 }]),
    { upload: 4, download: 6, total: 30, expire: 100 },
  );
  assert.deepEqual(sumUserinfo([{ upload: 1, download: 1, total: 0, expire: 0 }, { upload: 1, download: 1, total: 5, expire: 9 }]), { upload: 2, download: 2, total: 0, expire: 9 });
  assert.equal(sumUserinfo([null]), null);
});

test('客户的外部订阅:存取、用法开关;改地址时没变的保留上次结果;删客户一起删', async () => {
  const db = memoryDb();
  const id = createCustomer(db, { name: 'c', upstreams: [A, B], upstream_mode: 'replace', upstream_userinfo: true });
  let c = getCustomer(db, id)!;
  assert.deepEqual([c.upstream_mode, c.upstream_userinfo, c.upstreams.map((u) => [u.url, u.nodes, u.ok_at])], ['replace', true, [[A, 0, 0], [B, 0, 0]]]);
  assert.throws(() => updateCustomer(db, id, { upstream_mode: 'both' }), /merge|replace/);

  const fetcher: UpstreamFetcher = async (url) => ({ status: 200, body: url === A ? LINK : `${LINK}2`, userinfo: url === A ? 'upload=1; download=2; total=3; expire=4' : null });
  await refreshUpstreams(db, id, fetcher);
  updateCustomer(db, id, { upstreams: [B, 'https://new.example.com/s'], upstream_userinfo: false });
  c = getCustomer(db, id)!;
  assert.equal(c.upstream_userinfo, false);
  assert.equal(c.upstream_mode, 'replace');
  assert.deepEqual(c.upstreams.map((u) => [u.url, u.nodes]), [[B, 1], ['https://new.example.com/s', 0]]);
  assert.deepEqual(cachedUpstream(db, id).links, [`${LINK}2`]);

  deleteCustomer(db, id);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM upstream_subs').get() as { n: number }).n, 0);
});

test('取订阅:60 秒内不重复取;取不到时保留上次成功的;没有节点也算没取到;同时只取一次', async () => {
  const db = memoryDb();
  const id = createCustomer(db, { name: 'c', upstreams: [A] });
  let calls = 0;
  let reply: () => Promise<{ status: number; body: string; userinfo: string | null }> = async () => ({ status: 200, body: Buffer.from(`${LINK}\n`).toString('base64'), userinfo: 'upload=5; download=6; total=100; expire=0' });
  const fetcher: UpstreamFetcher = async () => {
    calls++;
    return reply();
  };

  await Promise.all([refreshUpstreams(db, id, fetcher), refreshUpstreams(db, id, fetcher)]);
  assert.equal(calls, 1);
  let up = getCustomer(db, id)!.upstreams[0];
  assert.deepEqual([up.nodes, up.error, up.userinfo], [1, '', { upload: 5, download: 6, total: 100, expire: 0 }]);
  assert.ok(up.ok_at > 0 && up.ok_at === up.tried_at);

  await refreshUpstreams(db, id, fetcher);
  assert.equal(calls, 1);

  for (const [res, msg] of [
    [async () => ({ status: 403, body: 'forbidden', userinfo: null }), /HTTP 403/],
    [async () => ({ status: 200, body: '<html></html>', userinfo: null }), /没有节点/],
    [async () => ({ status: 200, body: 'proxies:\n  - {name: w, type: wireguard, server: 203.0.113.1, port: 1}\n', userinfo: null }), /1 个节点的协议都不支持/],
    [
      async () => {
        throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
      },
      /fetch failed\(ECONNREFUSED\)/,
    ],
  ] as const) {
    reply = res;
    await refreshUpstreams(db, id, fetcher, { force: true });
    up = getCustomer(db, id)!.upstreams[0];
    assert.match(up.error, msg);
    // 上次成功的结果还在
    assert.deepEqual([up.nodes, cachedUpstream(db, id).links, cachedUpstream(db, id).failed], [1, [LINK], 0]);
    assert.ok(up.tried_at >= up.ok_at);
  }
  assert.equal(calls, 5);

  // onlyNew:只取还没取过的
  updateCustomer(db, id, { upstreams: [A, B] });
  await refreshUpstreams(db, id, fetcher, { onlyNew: true });
  assert.equal(calls, 6);
  // B 一次都没取到:算一个取不到的来源
  assert.deepEqual([cachedUpstream(db, id).total, cachedUpstream(db, id).failed], [2, 1]);
});

test('外部订阅的节点名:按每个外部订阅存;只给地址的保留原来的名字;改名不用重新取,订阅里马上换', async () => {
  const db = memoryDb();
  const id = createCustomer(db, { name: 'c', upstreams: [{ url: A, node_name: '美国 {n}' }, B] });
  const fetcher: UpstreamFetcher = async (url) => ({ status: 200, body: url === A ? `${LINK}\n${LINK}x` : `${LINK}y`, userinfo: null });
  await refreshUpstreams(db, id, fetcher);
  let ups = getCustomer(db, id)!.upstreams;
  assert.deepEqual(ups.map((u) => [u.node_name, u.names]), [['美国 {n}', ['美国 1', '美国 2']], ['', ['ay']]]);
  assert.deepEqual(cachedUpstream(db, id).links.map((l) => l.slice(l.indexOf('#'))), ['#%E7%BE%8E%E5%9B%BD%201', '#%E7%BE%8E%E5%9B%BD%202', '#ay']);

  // 只给地址:名字不动;给了 node_name:改掉
  updateCustomer(db, id, { upstreams: [A, { url: B, node_name: '备用' }] });
  ups = getCustomer(db, id)!.upstreams;
  assert.deepEqual(ups.map((u) => [u.node_name, u.names]), [['美国 {n}', ['美国 1', '美国 2']], ['备用', ['备用']]]);
  assert.throws(() => updateCustomer(db, id, { upstreams: [{ url: A, node_name: 'x'.repeat(65) }] }), /64/);
});
