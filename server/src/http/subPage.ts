// 客户自助页:浏览器打开订阅链接看到的页面。只给这位客户自己的信息:剩余流量、到期日、订阅链接、二维码、一键导入各客户端,
// 以及订阅里的线路(节点名 + 浏览器直连测的延迟)。不出现面板后台地址、API、其他客户,也不露后台是什么程序。

import qrcode from 'qrcode-generator';
import type { CustomerView } from '../customers/repo';
import { linkName } from '../subscription/nodeName';
import { parseNode } from '../subscription/nodes';
import type { SubDevice } from '../subscription/devices';
import type { Userinfo } from '../subscription/upstream';

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

/** 自助页列的一条线路:订阅里的节点名和节点地址(浏览器拿去直连测延迟)。不带 UUID、密码这些能直接用的东西 */
export interface PageNode {
  name: string;
  host: string;
  port: number;
  /** hy2 / tuic 走 UDP:浏览器只能测 TCP,测不到不代表不能用 */
  udp: boolean;
}

const UDP_SCHEMES = new Set(['hysteria2', 'hy2', 'hysteria', 'tuic']);

/** 订阅里的节点链接 → 页面上列的线路;名字和订阅里一样(重名的和 Clash 配置一样加「 2」「 3」),认不出地址的跳过 */
export function pageNodes(links: string[]): PageNode[] {
  const taken = new Set<string>();
  const out: PageNode[] = [];
  for (const link of links) {
    const scheme = link.slice(0, link.indexOf('://')).toLowerCase();
    let host = '';
    let port = 0;
    let name = '';
    const node = parseNode(link);
    if (node) {
      ({ server: host, port, name } = node);
    } else {
      try {
        const u = new URL(link);
        host = u.hostname.replace(/^\[|\]$/g, '');
        port = Number(u.port);
        name = linkName(link);
      } catch {
        continue;
      }
    }
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) continue;
    name ||= `${host}:${port}`;
    let unique = name;
    for (let i = 2; taken.has(unique); i++) unique = `${name} ${i}`;
    taken.add(unique);
    out.push({ name: unique, host, port, udp: UDP_SCHEMES.has(scheme) });
  }
  return out;
}

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
  /** 拉过订阅的设备 */
  devices?: SubDevice[];
  /** 刚移除了一台设备 */
  removed?: boolean;
  /** 配了外部订阅:那边的节点数;replace = 只给那边的节点;userinfo = 流量和到期用那边给的 */
  upstream?: { nodes: number; replace: boolean; userinfo: Userinfo | null };
}

/** UA 里的客户端名和版本,如 "clash-verge/v2.4.2 (…)" → "clash-verge v2.4.2" */
export function deviceName(ua: string): string {
  const first = ua.trim().split(/\s+/)[0] ?? '';
  return first ? first.replace('/', ' ').slice(0, 40) : '未知客户端';
}

const fmtAgo = (ms: number, now: number) => {
  const m = Math.max(0, Math.floor((now - ms) / 60_000));
  if (m < 1) return '刚刚';
  if (m < 60) return `${m} 分钟前`;
  if (m < 1440) return `${Math.floor(m / 60)} 小时前`;
  return `${Math.floor(m / 1440)} 天前`;
};

const STATE: Record<string, { label: string; cls: string }> = { active: { label: '正常', cls: 'ok' }, expired: { label: '已到期', cls: 'bad' }, over_quota: { label: '流量已用完', cls: 'bad' } };

export function renderSubPage({ customer: c, url, devices = [], removed = false, upstream }: SubPageData, now = Date.now()): string {
  const st = STATE[c.state] ?? STATE.active;
  // 流量和到期用外部订阅给的(和订阅里的 subscription-userinfo 一致);状态和停用照旧按客户自己的
  const theirs = upstream?.userinfo;
  const quota = theirs ? theirs.total : c.quota_bytes;
  const used = theirs ? theirs.upload + theirs.download : c.used;
  const expireAt = theirs ? theirs.expire * 1000 : c.expire_at;
  const pct = quota ? Math.min(100, Math.round((used / quota) * 100)) : 0;
  const left = quota ? Math.max(0, quota - used) : 0;
  const days = expireAt ? Math.ceil((expireAt - now) / 86_400_000) : 0;
  const expire = !expireAt ? '不限期' : days < 0 ? `${fmtDate(expireAt)}(已到期)` : days === 0 ? `${fmtDate(expireAt)}(今天到期)` : `${fmtDate(expireAt)}(还有 ${days} 天)`;
  // 线路由页面再去取(/sub/<token>/nodes):从面板现取链接可能要等几秒,不拖慢页面打开
  const links = importLinks(url, c.name);
  const full = c.limit_devices > 0 && devices.length >= c.limit_devices;
  const base = new URL(url).pathname;
  const deviceRows = devices
    .map(
      (d) =>
        `<li><span class="pname">${esc(deviceName(d.ua))}</span><span class="muted">${esc(d.ip || '未知 IP')} · ${fmtAgo(d.last_at, now)}更新过订阅</span>` +
        `<form method="post" action="${esc(`${base}/devices/${d.id}/delete`)}" onsubmit="return confirm('移除这台设备?它下次更新订阅会失败,除非名额还有空。')"><button class="del">移除</button></form></li>`,
    )
    .join('');
  const deviceCard =
    c.limit_devices > 0 || devices.length
      ? `<div class="card">
  <div class="row"><h2>设备</h2><span class="muted">${c.limit_devices > 0 ? `${devices.length} / ${c.limit_devices} 台` : `${devices.length} 台,不限`}</span></div>
  ${removed ? '<div class="okmsg">已移除。现在可以在新设备上更新订阅了。</div>' : ''}
  ${full ? '<div class="notice">设备数已到上限,新设备更新订阅会失败。要换设备,先在下面移除一台不用的。</div>' : c.limit_devices > 0 ? '<div class="muted">每个导入过订阅的客户端算一台。</div>' : ''}
  ${deviceRows ? `<ul class="lines devices">${deviceRows}</ul>` : '<div class="muted">还没有设备导入过订阅。</div>'}
</div>`
      : '';
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
.apps{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:10px;margin-top:12px}
.app{display:flex;flex-direction:column;gap:2px;padding:11px 12px;border:1.5px solid var(--accent);border-radius:10px;background:var(--sheet);color:var(--ink);text-decoration:none;box-shadow:0 1px 2px rgba(16,24,40,.06);transition:background .15s,transform .1s}
.app:hover{background:var(--accent-soft)}.app:active{transform:scale(.98)}.app:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.app b{font-weight:600;font-size:14px}.app span{margin-top:auto;color:var(--accent);font-size:12px;font-weight:600}
.steps{margin:6px 0 0;padding-left:20px;color:var(--soft);font-size:13px}.steps li{margin:2px 0}
.qr{display:flex;justify-content:center;margin-top:12px}.qr svg{width:200px;height:200px;border-radius:8px}
ul.lines{list-style:none;margin:8px 0 0;padding:0}ul.lines li{display:flex;gap:10px;align-items:center;padding:8px 0;border-top:1px solid var(--rule);flex-wrap:wrap}ul.lines li:first-child{border-top:none}
.pname{font-weight:500}
.nodes li{justify-content:space-between;flex-wrap:nowrap}.nodes .pname{min-width:0;overflow-wrap:anywhere}
.ms{flex:none;font-size:13px;font-variant-numeric:tabular-nums;font-weight:600;color:var(--soft)}.ms.good{color:var(--ok)}.ms.mid{color:var(--warn)}.ms.slow{color:var(--bad)}
.h2row{display:flex;justify-content:space-between;align-items:center;gap:12px}.small{font-size:13px;padding:5px 10px}
.notice{background:var(--bad-bg);color:var(--bad);border-radius:8px;padding:10px 12px;margin-top:10px;font-size:14px}
h2{font-size:15px;margin:0 0 4px}
.devices form{margin-left:auto}.del{font-size:13px;padding:5px 10px;color:var(--bad)}.okmsg{background:var(--ok-bg);color:var(--ok);border-radius:8px;padding:10px 12px;margin-top:10px;font-size:14px}
</style>
</head>
<body><div class="wrap">
<h1>${esc(c.name)}<span class="tag ${st.cls}">${st.label}</span></h1>
<div class="muted">订阅链接会自动更新,导入一次就行</div>

<div class="card">
  <div class="row"><span class="big">${quota ? `剩余 ${fmtBytes(left)}` : '流量不限'}</span><span class="muted">${quota ? `已用 ${fmtBytes(used)} / ${fmtBytes(quota)}` : `已用 ${fmtBytes(used)}`}</span></div>
  ${quota ? `<div class="bar"><i class="${pct >= 100 ? 'bad' : pct >= 90 ? 'warn' : ''}" style="width:${pct}%"></i></div>` : ''}
  <div class="row"><span class="muted">到期:${esc(expire)}</span>${!theirs && c.next_reset_at ? `<span class="muted">流量每月重置,下次 ${esc(fmtDate(c.next_reset_at))}</span>` : ''}</div>
  ${c.state !== 'active' ? `<div class="notice">${c.state === 'expired' ? '套餐已到期,线路已停用。' : '流量已用完,线路已停用。'}请联系你的服务提供方。</div>` : ''}
</div>

<div class="card">
  <h2>一键导入</h2>
  <ol class="steps">
    <li>先在手机或电脑上装好你要用的客户端。</li>
    <li>点下面对应的按钮,会打开这个客户端并自动添加订阅。</li>
  </ol>
  <div class="apps">${links.map((l) => `<a class="app" href="${esc(l.href)}"><b>${esc(l.app)}</b><span>点击导入 →</span></a>`).join('')}</div>
  <div class="muted" style="margin-top:12px">没反应?说明没装这个客户端,或者它不支持一键导入:复制下面的订阅链接,在客户端里手动添加。</div>
</div>

<div class="card">
  <h2>订阅链接</h2>
  <div class="muted">v2rayN、NekoBox、Karing 等:复制后在客户端里「从剪贴板导入订阅」。</div>
  <div class="sub"><input id="u" readonly value="${esc(url)}" onclick="this.select()"><button class="primary" onclick="copy()">复制</button></div>
  <div class="qr">${qrSvg(url)}</div>
  <div class="muted" style="text-align:center">手机扫码添加订阅</div>
</div>

<div class="card">
  <div class="h2row"><h2>线路</h2><button class="small" id="reping" disabled onclick="pingAll()">重新测速</button></div>
  <div class="muted">延迟是你这台设备的浏览器直接连各节点测的。测之前先关掉代理客户端(包括 TUN / 增强模式),不然测的是经过代理的,数字不准。含建立连接的时间,比客户端里显示的高一些,只作参考。</div>
  <ul class="lines nodes" id="nodes"><li class="muted">正在读取线路…</li></ul>
</div>

${deviceCard}
</div>
<script>
function copy(){var i=document.getElementById('u');i.select();var done=function(){var b=document.querySelector('.sub button');b.textContent='已复制';setTimeout(function(){b.textContent='复制'},1500)};
if(navigator.clipboard){navigator.clipboard.writeText(i.value).then(done,function(){document.execCommand('copy');done()})}else{document.execCommand('copy');done()}}
var NODES=[],busy=false,box=document.getElementById('nodes'),again=document.getElementById('reping');
function msg(t){box.innerHTML='';var li=document.createElement('li');li.className='muted';li.textContent=t;box.appendChild(li)}
function show(){box.innerHTML='';NODES.forEach(function(n){var li=document.createElement('li'),a=document.createElement('span'),b=document.createElement('span');a.className='pname';a.textContent=n.name;b.className='ms';b.textContent='等待测速';n.el=b;li.appendChild(a);li.appendChild(b);box.appendChild(li)})}
/* 浏览器直接连节点地址(https,不带 cookie),从发出到连接结束(握手完成被拒或报错)的时间;超过 4 秒算超时 */
function probe(n){var h=n.host.indexOf(':')>=0?'['+n.host+']':n.host,c=new AbortController(),t0=performance.now(),tm=setTimeout(function(){c.abort()},4000);
return fetch('https://'+h+':'+n.port+'/?t='+Math.random(),{mode:'no-cors',cache:'no-store',credentials:'omit',referrerPolicy:'no-referrer',signal:c.signal}).then(function(){},function(){}).then(function(){clearTimeout(tm);return c.signal.aborted?-1:performance.now()-t0})}
function one(n){n.el.className='ms';n.el.textContent='测速中…';n.el.title='';var best=1e9,k=0;
return (function next(){return probe(n).then(function(ms){if(ms<0){if(best===1e9)return -1;return best}best=Math.min(best,ms);return ++k<3?next():best})})().then(function(ms){
if(ms<0){n.el.textContent=n.udp?'测不了':'超时';n.el.className='ms slow';if(n.udp){n.el.className='ms';n.el.title='这条是 UDP 线路,浏览器只能测 TCP,测不到不代表不能用'}return}
/* 立刻失败(浏览器禁止连这个端口等)不是网络延迟 */
if(ms<3){n.el.textContent='测不了';n.el.title='浏览器不允许连这个端口,用客户端测';return}
n.el.textContent=Math.round(ms)+' ms';n.el.className='ms '+(ms<200?'good':ms<400?'mid':'slow')})}
function pingAll(){if(busy||!NODES.length)return;busy=true;again.disabled=true;var q=NODES.slice();
function worker(){var n=q.shift();return n?one(n).then(worker):Promise.resolve()}
Promise.all([worker(),worker(),worker()]).then(function(){busy=false;again.disabled=false})}
fetch(${JSON.stringify(`${new URL(url).pathname}/nodes`).replace(/</g, '\\u003c')},{cache:'no-store'}).then(function(r){return r.json()}).then(function(d){NODES=d.nodes||[];
if(!NODES.length){msg(d.error||(${JSON.stringify(c.state !== 'active')}?'线路已停用。':'还没有线路。'));return}show();pingAll()},function(){msg('线路读取失败,稍后刷新再看。')});
</script>
</body></html>`;
}
