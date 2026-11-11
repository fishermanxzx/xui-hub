// 客户自助页:浏览器打开订阅链接看到的页面。只给这位客户自己的信息:剩余流量、到期日、订阅链接、二维码、一键导入各客户端。
// 不出现面板地址、API、其他客户。

import qrcode from 'qrcode-generator';
import type { CustomerView } from '../customers/repo';

const GB = 1024 ** 3;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const fmtBytes = (n: number) => {
  if (n >= GB) return `${(n / GB).toFixed(n >= 10 * GB ? 1 : 2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(0)} MB`;
  return `${Math.round(n / 1024)} KB`;
};
const fmtDate = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const PROTOCOL: Record<string, string> = { hysteria: 'hy2' };

export function qrSvg(text: string): string {
  const qr = qrcode(0, 'M');
  qr.addData(text.replace(/[^\x00-\x7f]/g, (c) => encodeURIComponent(c)));
  qr.make();
  const n = qr.getModuleCount();
  const quiet = 2;
  let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + quiet},${r + quiet}h1v1h-1z`;
  const size = n + quiet * 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="#fff"/><path d="${d}" fill="#0f2a33"/></svg>`;
}

/** 各客户端的一键导入链接(与主流面板订阅页一致) */
export function importLinks(url: string, name: string): { app: string; href: string }[] {
  const u = encodeURIComponent(url);
  const n = encodeURIComponent(name);
  const b64 = Buffer.from(url, 'utf8').toString('base64').replace(/=+$/, '');
  return [
    { app: 'Clash Verge / Mihomo', href: `clash://install-config?url=${u}&name=${n}` },
    { app: 'Stash', href: `stash://install-config?url=${u}&name=${n}` },
    { app: 'Shadowrocket', href: `shadowrocket://add/sub://${b64}?remark=${n}` },
    { app: 'sing-box', href: `sing-box://import-remote-profile?url=${u}#${n}` },
    { app: 'Hiddify', href: `hiddify://import/${url}#${n}` },
    { app: 'Surge', href: `surge:///install-config?url=${u}` },
    { app: 'Quantumult X', href: `quantumult-x:///add-resource?remote-resource=${encodeURIComponent(JSON.stringify({ server_remote: [`${url}, tag=${name}`] }))}` },
    { app: 'Loon', href: `loon://import?sub=${u}` },
  ];
}

export interface SubPageData {
  customer: CustomerView;
  /** 完整订阅链接 */
  url: string;
}

const STATE: Record<string, { label: string; cls: string }> = { active: { label: '正常', cls: 'ok' }, expired: { label: '已到期', cls: 'bad' }, over_quota: { label: '流量已用完', cls: 'bad' } };

export function renderSubPage({ customer: c, url }: SubPageData, now = Date.now()): string {
  const st = STATE[c.state] ?? STATE.active;
  const pct = c.quota_bytes ? Math.min(100, Math.round((c.used / c.quota_bytes) * 100)) : 0;
  const left = c.quota_bytes ? Math.max(0, c.quota_bytes - c.used) : 0;
  const days = c.expire_at ? Math.ceil((c.expire_at - now) / 86_400_000) : 0;
  const expire = !c.expire_at ? '不限期' : days < 0 ? `${fmtDate(c.expire_at)}(已到期)` : days === 0 ? `${fmtDate(c.expire_at)}(今天到期)` : `${fmtDate(c.expire_at)}(还有 ${days} 天)`;
  const links = importLinks(url, c.name);
  const lines = c.lines
    .map(
      (l) =>
        `<li><span class="proto">${esc(PROTOCOL[l.protocol] ?? l.protocol)}</span><span class="pname">${esc(l.panel_name)}</span>` +
        `<span class="muted">${l.kind === 'relay' ? '中转' : '直连'} · 已用 ${fmtBytes(l.up + l.down)}</span>` +
        (l.enable ? '' : '<span class="tag bad">已停用</span>') +
        `</li>`,
    )
    .join('');
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(c.name)} 的订阅</title>
<style>
:root{--bg:#f5f6f8;--sheet:#fff;--ink:#15181e;--soft:#667085;--rule:#e4e7ec;--accent:#5157e0;--accent-soft:#eef0ff;--ok:#067647;--ok-bg:#ecfdf3;--bad:#d92d20;--bad-bg:#fef3f2;--warn:#b54708;--bar:#e4e7ec}
@media(prefers-color-scheme:dark){:root{--bg:#0a0b0d;--sheet:#111318;--ink:#ededf0;--soft:#8b8f98;--rule:#23262d;--accent:#7b80ff;--accent-soft:#1c1e3a;--ok:#4ade80;--ok-bg:#0d2a1a;--bad:#f87171;--bad-bg:#2d1414;--warn:#fbbf24;--bar:#23262d}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC","HarmonyOS Sans SC","Microsoft YaHei","Noto Sans SC",sans-serif;-webkit-font-smoothing:antialiased}
.wrap{max-width:560px;margin:0 auto;padding:24px 16px 40px}h1{font-size:20px;margin:0 0 4px;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.card{background:var(--sheet);border:1px solid var(--rule);border-radius:12px;padding:16px;margin-top:14px}
.tag{display:inline-block;font-size:12px;line-height:1;padding:5px 8px;border-radius:999px;font-weight:600}.tag.ok{background:var(--ok-bg);color:var(--ok)}.tag.bad{background:var(--bad-bg);color:var(--bad)}
.muted{color:var(--soft);font-size:13px}.row{display:flex;justify-content:space-between;gap:12px;align-items:baseline;flex-wrap:wrap}
.bar{height:8px;background:var(--bar);border-radius:999px;overflow:hidden;margin:8px 0 6px}.bar i{display:block;height:100%;background:var(--accent);border-radius:999px}.bar i.warn{background:var(--warn)}.bar i.bad{background:var(--bad)}
.big{font-size:22px;font-weight:600}
.sub{display:flex;gap:8px;margin-top:8px}.sub input{flex:1;min-width:0;font:13px ui-monospace,SFMono-Regular,Menlo,monospace;padding:9px 10px;border:1px solid var(--rule);border-radius:8px;background:var(--bg);color:var(--ink)}
button,.btn{font:inherit;font-size:14px;padding:9px 14px;border-radius:8px;border:1px solid var(--rule);background:var(--sheet);color:var(--ink);cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;justify-content:center}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
.apps{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px;margin-top:10px}.apps .btn{background:var(--accent-soft);border-color:transparent;color:var(--accent);font-weight:500}
.qr{display:flex;justify-content:center;margin-top:12px}.qr svg{width:200px;height:200px;border-radius:8px}
ul.lines{list-style:none;margin:8px 0 0;padding:0}ul.lines li{display:flex;gap:10px;align-items:center;padding:8px 0;border-top:1px solid var(--rule);flex-wrap:wrap}ul.lines li:first-child{border-top:none}
.proto{font-size:12px;font-weight:600;background:var(--accent-soft);color:var(--accent);padding:2px 7px;border-radius:6px}.pname{font-weight:500}
.notice{background:var(--bad-bg);color:var(--bad);border-radius:8px;padding:10px 12px;margin-top:10px;font-size:14px}
footer{margin-top:24px;text-align:center}footer a{color:var(--soft);text-decoration:none;font-size:12px}
h2{font-size:15px;margin:0 0 4px}
</style>
</head>
<body><div class="wrap">
<h1>${esc(c.name)}<span class="tag ${st.cls}">${st.label}</span></h1>
<div class="muted">${c.lines.length} 条线路 · 订阅链接自动更新</div>

<div class="card">
  <div class="row"><span class="big">${c.quota_bytes ? `剩余 ${fmtBytes(left)}` : '流量不限'}</span><span class="muted">${c.quota_bytes ? `已用 ${fmtBytes(c.used)} / ${fmtBytes(c.quota_bytes)}` : `已用 ${fmtBytes(c.used)}`}</span></div>
  ${c.quota_bytes ? `<div class="bar"><i class="${pct >= 100 ? 'bad' : pct >= 90 ? 'warn' : ''}" style="width:${pct}%"></i></div>` : ''}
  <div class="row"><span class="muted">到期:${esc(expire)}</span>${c.reset_day ? `<span class="muted">每月 ${c.reset_day} 号流量重置</span>` : ''}</div>
  ${c.state !== 'active' ? `<div class="notice">${c.state === 'expired' ? '套餐已到期,线路已停用。' : '流量已用完,线路已停用。'}请联系你的服务提供方。</div>` : ''}
</div>

<div class="card">
  <h2>订阅链接</h2>
  <div class="muted">在客户端里添加订阅,或点下面的按钮一键导入。</div>
  <div class="sub"><input id="u" readonly value="${esc(url)}" onclick="this.select()"><button class="primary" onclick="copy()">复制</button></div>
  <div class="apps">${links.map((l) => `<a class="btn" href="${esc(l.href)}">${esc(l.app)}</a>`).join('')}</div>
  <div class="muted" style="margin-top:10px">v2rayN、NekoBox、Karing 等:复制链接后在客户端里「从剪贴板导入订阅」。</div>
  <div class="qr">${qrSvg(url)}</div>
  <div class="muted" style="text-align:center">手机扫码添加订阅</div>
</div>

<div class="card">
  <h2>线路</h2>
  ${lines ? `<ul class="lines">${lines}</ul>` : '<div class="muted">还没有线路。</div>'}
</div>
<footer><a href="https://github.com/fishermanxzx/xui-hub" rel="noopener">xui-hub</a></footer>
</div>
<script>
function copy(){var i=document.getElementById('u');i.select();var done=function(){var b=document.querySelector('.sub button');b.textContent='已复制';setTimeout(function(){b.textContent='复制'},1500)};
if(navigator.clipboard){navigator.clipboard.writeText(i.value).then(done,function(){document.execCommand('copy');done()})}else{document.execCommand('copy');done()}}
</script>
</body></html>`;
}
