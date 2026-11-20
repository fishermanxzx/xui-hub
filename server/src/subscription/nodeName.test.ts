import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renameLink, renameLinks, validNodeName } from './nodeName';

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
