// README 截图用的假接口:静态页来自 web/dist,/api 返回演示数据(全是 example 域名和文档保留 IP)。
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { extname, join } from 'node:path';

const DIST = process.argv[2];
const PORT = Number(process.argv[3] || 18800);
const now = Date.now();
const DAY = 86_400_000;
const GB = 1024 ** 3;

const panels = [
  { id: 1, name: '香港中转-1', base_url: 'https://hk1.example.com:2053/panel', inbound_count: 2, client_count: 5, panel_version: '3.11.0', xray_version: '26.10.31' },
  { id: 2, name: '美国落地-1', base_url: 'https://us1.example.com:2053/panel', inbound_count: 3, client_count: 4, panel_version: '3.11.0', xray_version: '26.10.31' },
  { id: 3, name: '日本落地-1', base_url: 'https://jp1.example.com:2053/panel', inbound_count: 2, client_count: 2, panel_version: '3.10.2', xray_version: '26.10.21' },
].map((p) => ({ ...p, created_at: now - 40 * DAY, checked_at: now - 20_000, check_ok_at: now - 20_000, check_error: null, xray_state: 'running' }));

const socks = [
  { id: 1, name: '美国家宽-ATT', host: 'isp-us.example.net', port: 10002, username: 'user01', has_password: true, remark: '月付,每月 5 号到期', check: { at: now - 600_000, ok: true, ms: 182, ip: '203.0.113.45', loc: 'US', error: null } },
  { id: 2, name: '台湾家宽', host: 'tw.example.net', port: 52755, username: 'tw88', has_password: true, remark: '', check: { at: now - 900_000, ok: true, ms: 96, ip: '198.51.100.23', loc: 'TW', error: null } },
  { id: 3, name: '备用机房', host: '192.0.2.77', port: 1080, username: '', has_password: false, remark: '临时', check: { at: now - 3_600_000, ok: false, ms: 10000, ip: null, loc: null, error: '连接代理失败:超时(10 秒)' } },
].map((s) => ({ ...s, created_at: now - 30 * DAY, updated_at: now - DAY }));

let lid = 0;
const line = (customer_id, o) => ({
  id: ++lid, customer_id, exit_kind: null, exit_panel_id: null, exit_panel_name: null, exit_port: null, exit_socks_id: null, exit_socks_name: null, exit_label: '',
  created_at: now - 12 * DAY, enable: true, auto_disabled: false, last_online: now - 180_000, synced_at: now - 20_000, ...o,
});
const customer = (id, name, remark, quotaGb, expireDays, lines, extra = {}) => {
  const used_up = lines.reduce((s, l) => s + l.up, 0);
  const used_down = lines.reduce((s, l) => s + l.down, 0);
  const used = used_up + used_down;
  const quota_bytes = quotaGb * GB;
  const expire_at = expireDays == null ? 0 : now + expireDays * DAY;
  const state = expire_at && expire_at <= now ? 'expired' : quota_bytes && used >= quota_bytes ? 'over_quota' : 'active';
  const token = ['8Fq2mXvT1kLr9aZc0WbnYeHd', 'pV7sQ3uJxN5tRg2Kc8LmZa1E', 'Hy6dTz4BwC9eXo3MfN1qKs7U'][id - 1];
  return { id, name, remark, quota_bytes, expire_at, sub_token: token, sub_url: `https://hub.example.com/sub/${token}`, sub_fetched_at: now - 2_400_000, sub_fetched_ua: 'clash-verge/v2.2.3', sub_clients: 2, sub_ips: 2, created_at: now - 30 * DAY, updated_at: now - DAY, lines, used_up, used_down, used, state, ...extra };
};
const customers = [
  customer(1, '张三', '月付 30', 200, 18, [
    line(1, { kind: 'direct', panel_id: 2, panel_name: '美国落地-1', inbound_id: 1, inbound_remark: 'vless-reality', protocol: 'vless', email: '张三', up: 2.1 * GB, down: 31.6 * GB }),
    line(1, { kind: 'relay', panel_id: 1, panel_name: '香港中转-1', inbound_id: 1, inbound_remark: 'vless-reality', protocol: 'vless', email: '张三', up: 1.3 * GB, down: 22.4 * GB, exit_kind: 'panel', exit_panel_id: 3, exit_panel_name: '日本落地-1', exit_port: 31825, exit_label: '落地 日本落地-1(relay-socks)' }),
    line(1, { kind: 'relay', panel_id: 1, panel_name: '香港中转-1', inbound_id: 2, inbound_remark: 'hy2', protocol: 'hysteria', email: '张三-2', up: 0.4 * GB, down: 5.6 * GB, exit_kind: 'socks', exit_socks_id: 1, exit_socks_name: '美国家宽-ATT', exit_label: 'SOCKS 美国家宽-ATT' }),
  ]),
  customer(2, '李四', '流量包', 100, 40, [
    line(2, { kind: 'relay', panel_id: 1, panel_name: '香港中转-1', inbound_id: 1, inbound_remark: 'vless-reality', protocol: 'vless', email: '李四', up: 6.2 * GB, down: 94.1 * GB, enable: false, auto_disabled: true, exit_kind: 'socks', exit_socks_id: 2, exit_socks_name: '台湾家宽', exit_label: 'SOCKS 台湾家宽' }),
  ], { sub_fetched_ua: 'Shadowrocket/2701 CFNetwork/3826 Darwin/24.6.0', sub_clients: 1, sub_ips: 1 }),
  customer(3, '王五', '', 0, 3, [
    line(3, { kind: 'direct', panel_id: 3, panel_name: '日本落地-1', inbound_id: 1, inbound_remark: 'hy2', protocol: 'hysteria', email: '王五', up: 0.8 * GB, down: 12.9 * GB }),
  ], { sub_fetched_ua: 'SFA/1.12.4 (sing-box 1.12.4)', sub_clients: 3, sub_ips: 5 }),
];

const c = (email, used, extra = {}) => ({ email, enable: true, up: used * 0.07 * GB, down: used * 0.93 * GB, total_bytes: 0, expiry_ms: 0, last_online: now - 240_000, ...extra });
const details = {
  1: { panel: { id: 1, name: '香港中转-1' }, fetched_at: now - 5000, unattached: [], inbounds: [
    { id: 1, remark: 'vless-reality', protocol: 'vless', port: 443, enable: true, transport: 'tcp / reality', clients: [c('张三', 23.7), c('李四', 100.3, { enable: false }), c('赵六', 8.2)] },
    { id: 2, remark: 'hy2', protocol: 'hysteria', port: 8443, enable: true, transport: 'hysteria / tls', clients: [c('张三-2', 6.0), c('钱七', 41.5, { last_online: now - 3 * DAY })] },
  ] },
  2: { panel: { id: 2, name: '美国落地-1' }, fetched_at: now - 5000, unattached: [], inbounds: [
    { id: 1, remark: 'vless-reality', protocol: 'vless', port: 443, enable: true, transport: 'tcp / reality', clients: [c('张三', 33.7), c('孙八', 2.4)] },
    { id: 2, remark: 'hy2', protocol: 'hysteria', port: 8443, enable: true, transport: 'hysteria / tls', clients: [c('周九', 17.9)] },
    { id: 3, remark: 'relay-socks', protocol: 'mixed', port: 31080, enable: true, transport: 'tcp', clients: [] },
  ] },
  3: { panel: { id: 3, name: '日本落地-1' }, fetched_at: now - 5000, unattached: [], inbounds: [
    { id: 1, remark: 'hy2', protocol: 'hysteria', port: 8443, enable: true, transport: 'hysteria / tls', clients: [c('王五', 13.7)] },
    { id: 2, remark: 'relay-socks', protocol: 'mixed', port: 31825, enable: true, transport: 'tcp', clients: [] },
  ] },
};

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.png': 'image/png', '.svg': 'image/svg+xml' };
createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const json = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  const p = url.pathname;
  if (p === '/api/session') return json({ auth_required: true, logged_in: true });
  if (p === '/api/customers') return json(customers);
  if (p === '/api/panels') return json(panels);
  if (p === '/api/socks') return json(socks);
  let m;
  if ((m = p.match(/^\/api\/panels\/(\d+)\/inbounds$/))) return json(details[m[1]]);
  if ((m = p.match(/^\/api\/panels\/(\d+)\/versions$/))) {
    const pn = panels.find((x) => x.id === Number(m[1]));
    return json({ panel: { current: pn.panel_version, latest: 'v3.11.0', update_available: pn.panel_version !== '3.11.0', channel: 'stable' }, xray: { current: pn.xray_version, state: 'running', error: '', available: ['v26.10.31', 'v26.10.21', 'v26.9.30', 'v26.9.9'] } });
  }
  if (p.startsWith('/api/')) return json({});
  const file = join(DIST, p === '/' ? 'index.html' : p);
  if (!existsSync(file)) { res.writeHead(200, { 'Content-Type': MIME['.html'] }); return res.end(readFileSync(join(DIST, 'index.html'))); }
  res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
  res.end(readFileSync(file));
}).listen(PORT, '127.0.0.1', () => console.log('mock on', PORT));
