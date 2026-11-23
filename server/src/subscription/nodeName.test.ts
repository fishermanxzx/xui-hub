import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renameLink, renameLinks, validNodeName, linkName, renameByTemplate, uniqueNames } from './nodeName';

test('节点名:换掉 # 后面的名字;vmess 换 ps;多个链接依次加编号;空名不动', () => {
  assert.equal(renameLink('vless://u@1.2.3.4:443?security=reality&sni=a.com#old%20name', '香港 01'), 'vless://u@1.2.3.4:443?security=reality&sni=a.com#%E9%A6%99%E6%B8%AF%2001');
  assert.equal(renameLink('hysteria2://p@1.2.3.4:443?sni=a.com', 'HK'), 'hysteria2://p@1.2.3.4:443?sni=a.com#HK');
  const vmess = `vmess://${Buffer.from(JSON.stringify({ v: '2', ps: 'old', add: '1.2.3.4', port: 443, id: 'u' })).toString('base64')}`;
  const renamed = JSON.parse(Buffer.from(renameLink(vmess, '美国').slice(8), 'base64').toString('utf8'));
  assert.deepEqual([renamed.ps, renamed.add, renamed.id], ['美国', '1.2.3.4', 'u']);
  assert.deepEqual(renameLinks(['ss://a@h:1#x', 'ss://b@h:2#y'], 'JP'), ['ss://a@h:1#JP', 'ss://b@h:2#JP%202']);
  assert.deepEqual(renameLinks(['ss://a@h:1#x'], ''), ['ss://a@h:1#x']);
});

test('节点名校验:去空格、最长 64、不许控制字符', () => {
  assert.equal(validNodeName('  美国 01 '), '美国 01');
  assert.equal(validNodeName(undefined), '');
  assert.throws(() => validNodeName('a'.repeat(65)), /64/);
  assert.throws(() => validNodeName('a\nb'), /控制字符/);
});

test('外部订阅的节点名:空不动;固定名字依次编号;{name} 是原名、{n} 是序号;vmess 改 ps', () => {
  const vmess = `vmess://${Buffer.from(JSON.stringify({ v: '2', ps: '日本 01', add: 'v.example.com', port: '443', id: 'u' })).toString('base64')}`;
  const links = ['vless://u@203.0.113.1:443?security=reality#%F0%9F%87%BA%F0%9F%87%B8%20%E7%BE%8E%E5%9B%BD%2001', vmess];
  assert.deepEqual(links.map(linkName), ['🇺🇸 美国 01', '日本 01']);
  assert.deepEqual(renameByTemplate(links, ''), links);
  assert.deepEqual(renameByTemplate(links, '专线').map(linkName), ['专线', '专线 2']);
  assert.deepEqual(renameByTemplate(links, '专线-{name}').map(linkName), ['专线-🇺🇸 美国 01', '专线-日本 01']);
  assert.deepEqual(renameByTemplate(links, '美国 {n}').map(linkName), ['美国 1', '美国 2']);
  assert.equal(linkName('vless://u@203.0.113.1:443'), '');
});

test('一份订阅里节点名不重:重名的依次加 2、3,跳过已被占用的;没名字的不动', () => {
  const vmess = (ps: string) => 'vmess://' + Buffer.from(JSON.stringify({ v: '2', ps, add: 'h', port: '1', id: 'u' })).toString('base64');
  const out = uniqueNames(['vless://a@h:1#X', 'vless://b@h:1#X', 'vless://c@h:1#X%202', vmess('X'), 'vless://d@h:1']);
  assert.deepEqual(out.map(linkName), ['X', 'X 2', 'X 2 2', 'X 3', '']);
  assert.equal(out[4], 'vless://d@h:1');
});
