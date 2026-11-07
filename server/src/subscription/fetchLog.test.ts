import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCustomer } from '../customers/repo';
import { memoryDb } from '../testUtil';
import { recordSubFetch, subClientCounts } from './fetchLog';

test('按客户统计近几天用了几个客户端(不同 UA)和几个 IP,只算时间窗口内的', () => {
  const db = memoryDb();
  const a = createCustomer(db, { name: 'a' });
  const b = createCustomer(db, { name: 'b' });
  const fetch = (customer_id: number, at: number, ua: string, ip: string) => recordSubFetch(db, { at, customer_id, target: 'clash', status: 200, ua, ip });
  fetch(a, 100, 'clash-verge/v2.5.8', '1.1.1.1');
  fetch(a, 200, 'clash-verge/v2.5.8', '1.1.1.2');
  fetch(a, 300, 'Shadowrocket/2701 CFNetwork/3826 Darwin/24.6.0 iPhone17,5', '1.1.1.1');
  fetch(a, 10, 'Stash/3.6.5', '9.9.9.9');
  fetch(b, 150, '', '2.2.2.2');

  const counts = subClientCounts(db, 50);
  assert.deepEqual(counts.get(a), { clients: 2, ips: 2 });
  assert.deepEqual(counts.get(b), { clients: 1, ips: 1 });
  assert.equal(counts.size, 2);
});
