import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addLine, createCustomer } from '../customers/repo';
import { addPanel, memoryDb } from '../testUtil';
import { collectLinks, encodeSubscription, linkName, mergeLinks, userinfoHeader, type LinkFetcher } from './service';

function setup() {
  const db = memoryDb();
  const a = addPanel(db, 'a');
  const b = addPanel(db, 'b');
  const id = createCustomer(db, { name: 'zhu', quota_bytes: 1000, expire_at: 4_102_444_800_000 });
  const line = (panel_id: number) => addLine(db, { customer_id: id, kind: 'direct', panel_id, inbound_id: 1, inbound_remark: 'r', protocol: 'vless', email: 'zhu' });
  line(a.id);
  line(b.id);
  return { db, id };
}

function fetcherFrom(table: Record<string, string[] | Error>): LinkFetcher & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async (panel, _email) => {
    calls.push(panel.name);
    const v = table[panel.name];
    if (v instanceof Error) throw v;
    return v ?? [];
  }) as LinkFetcher & { calls: string[] };
  fn.calls = calls;
  return fn;
}

test('每次都从面板现取,线路换了链接马上生效', async () => {
  const { db, id } = setup();
  const first = fetcherFrom({ a: ['vless://x@1.1.1.1:1#A'], b: ['hysteria2://y@2.2.2.2:2#B'] });
  const lines = await collectLinks(db, id, first);
  assert.deepEqual(first.calls.sort(), ['a', 'b']);
  assert.deepEqual(mergeLinks(lines), ['vless://x@1.1.1.1:1#A', 'hysteria2://y@2.2.2.2:2#B']);

  const changed = fetcherFrom({ a: ['vless://x2@1.1.1.1:9#A'], b: ['hysteria2://y@2.2.2.2:2#B'] });
  assert.deepEqual(mergeLinks(await collectLinks(db, id, changed)), ['vless://x2@1.1.1.1:9#A', 'hysteria2://y@2.2.2.2:2#B']);
  assert.deepEqual(changed.calls.sort(), ['a', 'b']);
});

test('面板取不到时该线路不出节点,不用之前取到的', async () => {
  const { db, id } = setup();
  await collectLinks(db, id, fetcherFrom({ a: ['vless://x@1.1.1.1:1#A'], b: [] }));
  const lines = await collectLinks(db, id, fetcherFrom({ a: new Error('连接失败'), b: ['hysteria2://y@2.2.2.2:2#B'] }));
  assert.equal(lines[0].error, '连接失败');
  assert.deepEqual(lines[0].links, []);
  assert.deepEqual(mergeLinks(lines), ['hysteria2://y@2.2.2.2:2#B']);
});

test('编码与用户信息头', () => {
  assert.equal(Buffer.from(encodeSubscription(['a://1', 'b://2']), 'base64').toString(), 'a://1\r\nb://2\r\n');
  assert.equal(encodeSubscription([]), '');
  assert.equal(userinfoHeader({ used_up: 1, used_down: 2, quota_bytes: 3, expire_at: 4_000 }), 'upload=1; download=2; total=3; expire=4');
  assert.equal(linkName('vless://u@h:1?x=1#us-%E7%BE%8E%E5%9B%BD'), 'us-美国');
  assert.equal(linkName('vmess://' + Buffer.from(JSON.stringify({ ps: 'hk' })).toString('base64')), 'hk');
});
