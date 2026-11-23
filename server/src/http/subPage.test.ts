import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { addLine, createCustomer, deleteLine, getCustomer, updateLineStats } from '../customers/repo';
import { addPanel, memoryDb } from '../testUtil';
import { importLinks, pageNodes, qrSvg, renderSubPage, trendHtml } from './subPage';

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
  for (const s of ['a&amp;b', '剩余 60.0 GB', '已用 40.0 GB / 100.0 GB', '还有 10 天', '流量每月重置,下次 ', 'clash://install-config?url=https%3A%2F%2Fsub.example%2Fsub%2Ftok', '<svg', 'value="https://sub.example/sub/tok"']) assert.ok(html.includes(s), s);
  // 一键导入:每个按钮写明「点击导入」
  assert.equal(html.match(/<a class="app" href=/g)?.length, 8);
  assert.equal(html.match(/点击导入 →/g)?.length, 8);
  // 页面上不直接写线路(面板名、协议、线路数),线路由页面去取 /sub/<token>/nodes;不露后台程序
  for (const s of ['日本', '落地', 'hy2', '中转', '条线路', 'xui-hub', 'github']) assert.ok(!html.includes(s), s);
  assert.ok(html.includes('<h2>线路</h2>') && html.includes('fetch("/sub/tok/nodes"'));
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

test('自助页只给客户看按倍率算的用量:已用、剩余都是计费用量,看不到实际流量和倍率', () => {
  const db = memoryDb();
  const p = addPanel(db, 'hk');
  const GB = 1024 ** 3;
  const cid = createCustomer(db, { name: 'a', quota_bytes: 100 * GB, traffic_ratio: 2 });
  const l = addLine(db, { customer_id: cid, kind: 'direct', panel_id: p.id, inbound_id: 1, inbound_remark: 'r', protocol: 'vless', email: 'a' });
  const gone = addLine(db, { customer_id: cid, kind: 'direct', panel_id: p.id, inbound_id: 1, inbound_remark: 'r', protocol: 'vless', email: 'a2' });
  updateLineStats(db, l.id, { up: 0, down: 10 * GB, enable: true, last_online: 0 });
  updateLineStats(db, gone.id, { up: 0, down: 5 * GB, enable: true, last_online: 0 });
  deleteLine(db, gone.id);
  const html = renderSubPage({ customer: getCustomer(db, cid)!, url: 'https://sub.example/sub/tok' });
  for (const s of ['已用 30.0 GB / 100.0 GB', '剩余 70.0 GB']) assert.ok(html.includes(s), s);
  for (const s of ['15.0 GB', '10.0 GB', '倍率', '实际', '结转']) assert.ok(!html.includes(s), s);
});

test('自助页的线路:节点名和订阅里一样(重名加序号),地址给浏览器测延迟;hy2 / tuic 标 UDP;认不出地址的跳过', () => {
  const vmess = 'vmess://' + Buffer.from(JSON.stringify({ v: '2', ps: '美国 01', add: 'us.example.com', port: '8443', id: 'u', aid: '0', net: 'tcp' })).toString('base64');
  assert.deepEqual(
    pageNodes([
      'vless://secret-uuid@1.1.1.1:443?security=reality&pbk=k&sni=a.example.com#%E9%A6%99%E6%B8%AF%2001',
      'hysteria2://pw@2.2.2.2:8443?sni=b.example.com#%E9%A6%99%E6%B8%AF%2001',
      vmess,
      'tuic://u:p@[2001:db8::1]:9443#T',
      'vless://u@3.3.3.3:80',
      'socks://dXNlcjpwYXNz@4.4.4.4:1080#S',
      'vless://u@5.5.5.5#没端口',
      'garbage',
    ]),
    [
      { name: '香港 01', host: '1.1.1.1', port: 443, udp: false },
      { name: '香港 01 2', host: '2.2.2.2', port: 8443, udp: true },
      { name: '美国 01', host: 'us.example.com', port: 8443, udp: false },
      { name: 'T', host: '2001:db8::1', port: 9443, udp: true },
      { name: '3.3.3.3:80', host: '3.3.3.3', port: 80, udp: false },
      { name: 'S', host: '4.4.4.4', port: 1080, udp: false },
    ],
  );
});

test('自助页的每天用量:柱子和日期一一对应,纵轴取整,写日均和最多的一天;没数据 / 全是 0 不画', () => {
  const GB = 1024 ** 3;
  const days = Array.from({ length: 30 }, (_, i) => `2026-11-${String(i + 1).padStart(2, '0')}`);
  const bytes = days.map((_, i) => (i === 21 ? 1.86 * GB : i % 3 ? 0.5 * GB : 0));
  const html = trendHtml({ days, bytes });
  assert.equal(html.match(/<b data-d=/g)?.length, 30);
  for (const s of ['最近 30 天每天用量', '>2 GB<', '>1 GB<', 'data-d="11-22" data-v="1.86 GB"', '最多 11-22 用了 1.86 GB', '>11-01<', '>11-15<', '>11-30<']) assert.ok(html.includes(s), s);
  assert.match(html, /日均 [\d.]+ MB/);
  // 没用的那天没有柱子,最多的那天顶到 93%
  assert.ok(html.includes('data-d="11-01" data-v="0 KB" title="11-01 · 0 KB"><i style="height:0.0%">'));
  assert.ok(html.includes('style="height:93.0%"'));
  // 小流量:单位跟着变
  assert.ok(trendHtml({ days: days.slice(0, 7), bytes: [0, 0, 330 * 1024 ** 2, 0, 0, 0, 0] }).includes('>400 MB<'));
  assert.equal(trendHtml(undefined), '');
  assert.equal(trendHtml({ days, bytes: days.map(() => 0) }), '');
});

/** 在一个假浏览器里跑自助页的脚本:线路列表由 /nodes 给,记下测速探测连了哪些地址 */
async function runPage(nodes: { name: string; host: string; port: number; udp: boolean }[]) {
  const db = memoryDb();
  const html = renderSubPage({ customer: getCustomer(db, createCustomer(db, { name: 'a' }))!, url: 'https://sub.example/sub/tok' });
  const script = html.slice(html.lastIndexOf('<script>') + 8, html.lastIndexOf('</script>'));
  const el = (): any => {
    const e: any = { children: [] as any[], textContent: '', className: '', title: '', disabled: true };
    Object.defineProperty(e, 'innerHTML', { set: () => void (e.children = []) });
    e.appendChild = (c: any) => void e.children.push(c);
    return e;
  };
  const box = el();
  const again = el();
  const probed: string[] = [];
  let clock = 0;
  const ctx: any = {
    document: { getElementById: (id: string) => (id === 'nodes' ? box : id === 'reping' ? again : null), createElement: el, querySelectorAll: () => [] },
    fetch: (url: string) => {
      if (url.endsWith('/nodes')) return Promise.resolve({ json: () => Promise.resolve({ nodes }) });
      probed.push(new URL(url).host);
      return Promise.reject(new Error('refused'));
    },
    performance: { now: () => (clock += 60) },
    AbortController,
    setTimeout,
    clearTimeout,
    Math,
    Promise,
  };
  vm.runInNewContext(script, ctx);
  const settle = () => new Promise((r) => setTimeout(r, 30));
  await settle();
  const shown = () => box.children.map((li: any) => [li.children[0].textContent, li.children[1].textContent, li.children[1].className]);
  return { probed, shown, again, pingAll: async () => (ctx.pingAll(), await settle()) };
}

test('自助页测速:UDP 线路(hy2 / tuic)不发探测,直接提示用客户端测、不标红;TCP 线路照测,重新测速也只测 TCP;全是 UDP 时重新测速一直灰着', async () => {
  const page = await runPage([
    { name: '香港 vless', host: '198.51.100.1', port: 443, udp: false },
    { name: '美国 hy2', host: '198.51.100.2', port: 8443, udp: true },
  ]);
  assert.deepEqual(page.probed, ['198.51.100.1', '198.51.100.1', '198.51.100.1']);
  const [tcp, udp] = page.shown();
  assert.match(tcp[1], /^\d+ ms$/);
  assert.deepEqual(udp, ['美国 hy2', 'UDP 线路,请用客户端测', 'ms udp']);
  assert.equal(page.again.disabled, false);
  // 重新测速:还是只测 TCP 那条
  await page.pingAll();
  assert.equal(page.probed.filter((h) => h.startsWith('198.51.100.2')).length, 0);
  assert.equal(page.probed.length, 6);

  const allUdp = await runPage([{ name: 'hy2', host: '198.51.100.3', port: 443, udp: true }]);
  assert.deepEqual(allUdp.probed, []);
  assert.equal(allUdp.again.disabled, true);
  assert.match(allUdp.again.title, /都是 UDP 线路/);
});

test('自助页线路说明里写了 UDP 线路浏览器测不了(不写具体协议名)', () => {
  const db = memoryDb();
  const html = renderSubPage({ customer: getCustomer(db, createCustomer(db, { name: 'a' }))!, url: 'https://sub.example/sub/tok' });
  assert.ok(html.includes('UDP 线路浏览器测不了,看客户端里的延迟'));
});
