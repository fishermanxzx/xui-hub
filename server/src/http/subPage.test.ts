import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addLine, createCustomer, getCustomer, updateLineStats } from '../customers/repo';
import { addPanel, memoryDb } from '../testUtil';
import { importLinks, qrSvg, renderSubPage } from './subPage';

test('自助页:剩余流量、到期、线路、一键导入链接;HTML 转义;停用状态有提示', () => {
  const db = memoryDb();
  const p = addPanel(db, '日本<落地>', 'https://jp.example:2053/path');
  const GB = 1024 ** 3;
  const now = Date.now();
  const cid = createCustomer(db, { name: 'a&b', quota_bytes: 100 * GB, expire_at: now + 10 * 86_400_000, reset_day: 1 });
  const l = addLine(db, { customer_id: cid, kind: 'relay', panel_id: p.id, inbound_id: 1, inbound_remark: 'r', protocol: 'hysteria', email: 'a&b' });
  updateLineStats(db, l.id, { up: 10 * GB, down: 30 * GB, enable: true, last_online: 0 });
  const url = 'https://sub.example/sub/tok';
  const html = renderSubPage({ customer: getCustomer(db, cid)!, url }, now);
  for (const s of ['a&amp;b', '剩余 60.0 GB', '已用 40.0 GB / 100.0 GB', '还有 10 天', '每月 1 号流量重置', '日本&lt;落地&gt;', 'hy2', '中转 · 已用 40.0 GB', 'clash://install-config?url=https%3A%2F%2Fsub.example%2Fsub%2Ftok', '<svg', 'value="https://sub.example/sub/tok"']) assert.ok(html.includes(s), s);
  assert.ok(!html.includes('<落地>'));
  assert.ok(!html.includes('请联系你的服务提供方'));

  updateLineStats(db, l.id, { up: 100 * GB, down: 0, enable: false, last_online: 0 });
  const over = renderSubPage({ customer: getCustomer(db, cid)!, url }, now);
  assert.ok(over.includes('流量已用完') && over.includes('已停用') && over.includes('剩余 0 KB'));
});

test('导入链接覆盖主流客户端;二维码是 SVG', () => {
  const links = importLinks('https://s.example/sub/t', '张三');
  assert.deepEqual(links.map((l) => l.app), ['Clash Verge / Mihomo', 'Stash', 'Shadowrocket', 'sing-box', 'Hiddify', 'Surge', 'Quantumult X', 'Loon']);
  assert.ok(links[2].href.startsWith('shadowrocket://add/sub://aHR0cHM6Ly9zLmV4YW1wbGUvc3ViL3Q?remark='));
  assert.match(qrSvg('https://s.example/sub/t'), /^<svg .*<path d="M/);
});
