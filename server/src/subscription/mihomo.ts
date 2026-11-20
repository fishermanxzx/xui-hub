// Mihomo(Clash Meta)基础模板:替换 subconverter 生成的 Clash 配置头部(proxies: 之前的全局设置),
// 内容参照主流面板,Clash 系与 Stash 各一套。proxies 及之后(节点、策略组、ACL4SSR 规则)一字不动。
// 默认对所有客户生效(subconverter 自己的头部没有 dns 段),MIHOMO_TEMPLATE=off 关闭。
// 不开局域网访问(allow-lan: false):开着的话,连同一个 Wi-Fi 的人能直接用客户电脑上的代理端口。

import YAML from 'yaml';

// Mihomo 内核(Clash Verge / Mihomo Party / FlClash / ClashMeta 等)。
// - sniffer:从 TLS / HTTP 里嗅出域名,纯 IP 的连接也嗅(parse-pure-ip),只用来匹配规则、不改连接目标
// - profile.store-selected:重启后记住各分组手动选的节点
// - 地理数据用 geoip.dat / geosite.dat(geodata-mode),不自动更新;首次下载经 gh-proxy.com 加速(国内直连 GitHub 常下不动)
const CLASH_HEADER = `tcp-concurrent: true
unified-delay: true
mixed-port: 7890
allow-lan: false
mode: rule
log-level: info
external-controller: '127.0.0.1:9090'
find-process-mode: strict
profile: {store-selected: true}
sniffer:
    enable: true
    parse-pure-ip: true
    override-destination: false
    force-dns-mapping: true
    sniff:
        TLS: {ports: [443]}
        HTTP: {ports: [80, 8080, 8443]}
geodata-mode: true
geo-auto-update: false
geox-url:
    geoip: 'https://gh-proxy.com/https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/geoip.dat'
    geosite: 'https://gh-proxy.com/https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/geosite.dat'
    mmdb: 'https://gh-proxy.com/https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/country.mmdb'
dns:
    enable: true
    ipv6: false
    enhanced-mode: fake-ip
    fake-ip-range: 198.18.0.1/16
    fake-ip-filter: ['geosite:cn', 'geosite:private', 'geosite:apple', '*.lan', '*.local', '*.localhost', '*.test', +.lan, +.local, +.localdomain, +.localhost, +.example, +.invalid, +.test, '+.stun.*.*', '+.stun.*.*.*', '+.stun.*.*.*.*', +.stun.playstation.net, lens.l.google.com, '*.srv.nintendo.net', 'xbox.*.*.microsoft.com', '*.*.xboxlive.com', localhost.ptlogin2.qq.com, msftconnecttest.com, msftncsi.com, '*.msftconnecttest.com', '*.msftncsi.com', dns.msftncsi.com, www.msftncsi.com, www.msftconnecttest.com, time.windows.com, time.apple.com, time-ios.apple.com, time.asia.apple.com, ntp.aliyun.com, ntp1.aliyun.com, ntp2.aliyun.com, ntp3.aliyun.com, ntp4.aliyun.com, ntp5.aliyun.com, ntp6.aliyun.com, ntp7.aliyun.com, time1.cloud.tencent.com, ntp.ntsc.ac.cn, +.pool.ntp.org, connectivitycheck.android.com, android.clients.google.com, services.googleapis.cn, googleapis.cn, xn--ngstr-lra8j.com]
    respect-rules: true
    use-hosts: true
    default-nameserver: [119.29.29.29, 223.5.5.5]
    proxy-server-nameserver: [119.29.29.29, 223.5.5.5]
    direct-nameserver: [119.29.29.29, 223.5.5.5]
    nameserver: [119.29.29.29, 223.5.5.5]
    fallback: ['https://dns.google/dns-query', 'tls://1.1.1.1:853']
    fallback-filter: { geoip: true, geoip-code: CN, geosite: [gfw], ipcidr: [240.0.0.0/4], domain: [+.google.com, +.facebook.com, +.youtube.com] }
`;

// Stash 不支持 tcp-concurrent / unified-delay / geosite 等 Mihomo 专有写法,DNS 用 DoH
const STASH_HEADER = `mixed-port: 7890
allow-lan: false
mode: rule
log-level: info
external-controller: '127.0.0.1:9090'
dns:
    enable: true
    ipv6: false
    default-nameserver: [223.5.5.5, 119.29.29.29]
    enhanced-mode: fake-ip
    fake-ip-range: 198.18.0.1/16
    use-hosts: true
    nameserver: ['https://doh.pub/dns-query', 'https://dns.alidns.com/dns-query']
    fallback: ['https://doh-pure.onedns.net/dns-query', 'https://ada.openbld.net/dns-query', 'https://223.5.5.5/dns-query', 'https://223.6.6.6/dns-query']
    fallback-filter: { geoip: true, ipcidr: [240.0.0.0/4, 0.0.0.0/32] }
`;

/** 模板头部自己的键(解析一次);原头部里这些键以模板为准 */
const HEADER_KEYS = new Map([CLASH_HEADER, STASH_HEADER].map((h) => [h, new Set(Object.keys(YAML.parse(h)))]));

/** 模板用 mixed-port,原头部的这些端口项去掉,否则会与 mixed-port 抢同一端口 */
const PORT_KEYS = new Set(['port', 'socks-port', 'redir-port', 'tproxy-port', 'mixed-port']);

export function applyMihomoTemplate(yamlText: string, opts: { stash?: boolean } = {}): string {
  const at = yamlText.search(/^proxies:/m);
  if (at < 0) return yamlText;
  let original: unknown;
  try {
    original = YAML.parse(yamlText.slice(0, at)) ?? {};
  } catch {
    return yamlText;
  }
  if (typeof original !== 'object' || Array.isArray(original)) return yamlText;
  const header = opts.stash ? STASH_HEADER : CLASH_HEADER;
  const ours = HEADER_KEYS.get(header)!;
  // 原头部里模板没覆盖的其他项(自定义规则配置带的 hosts 等)保留在模板之后
  const extras = Object.fromEntries(Object.entries(original as Record<string, unknown>).filter(([k]) => !ours.has(k) && !PORT_KEYS.has(k)));
  return header + (Object.keys(extras).length ? YAML.stringify(extras, { lineWidth: 0 }) : '') + yamlText.slice(at);
}

/**
 * subconverter 转 trojan 时丢掉链接里的 fp,Mihomo 会用 Go 默认的 TLS 指纹;没写 client-fingerprint 的 trojan 节点补上。
 * 只改 subconverter 输出的单行写法 `- {name: ..., type: trojan, ...}`,其他行原样保留。
 */
export function withTrojanFingerprint(yamlText: string, fingerprint = 'chrome'): string {
  return yamlText.replace(/^([ \t]*- \{.*\btype: trojan\b.*?)\}[ \t]*$/gm, (line, head: string) =>
    /\bclient-fingerprint:/.test(head) ? line : `${head}, client-fingerprint: ${fingerprint}}`,
  );
}

/**
 * REALITY 节点打开 X25519MLKEM768:Mihomo 默认只用 X25519 握手,和真 Chrome(带后量子密钥交换)不一样;
 * 新版 Xray 服务端会拒掉这种握手,节点就连不上。3x-ui 自己生成的 Clash 配置也写了这一项。
 * subconverter 不认这个参数,这里给单行写法里的 `reality-opts: {...}` 补上,已经写了的不动。
 */
export function withRealityMlkem(yamlText: string): string {
  return yamlText.replace(/^([ \t]*- \{.*)$/gm, (line) =>
    line.replace(/(reality-opts: \{)([^{}]*)\}/, (m, head: string, body: string) => (/\bsupport-x25519mlkem768:/.test(body) ? m : `${head}${body}, support-x25519mlkem768: true}`)),
  );
}

/**
 * subconverter 生成的头部写的是 `mode: Rule`(首字母大写)。内核不分大小写照样认,但 Mihomo 的配置规范只列小写的
 * rule / global / direct,编辑器按规范校验会报错,有的客户端也只认小写。统一改成小写,只动 proxies: 之前的那一行。
 */
export function lowerMode(yamlText: string): string {
  const at = yamlText.search(/^proxies:/m);
  const head = at < 0 ? yamlText : yamlText.slice(0, at);
  return head.replace(/^(mode:[ \t]*)(['"]?)(rule|global|direct)\2[ \t]*$/im, (_m, key: string, _q, mode: string) => key + mode.toLowerCase()) + (at < 0 ? '' : yamlText.slice(at));
}

/** 模板关掉时 subconverter 的头部是 allow-lan: true,同样改成 false(只动 proxies: 之前的那一行) */
export function noLanAccess(yamlText: string): string {
  const at = yamlText.search(/^proxies:/m);
  const head = at < 0 ? yamlText : yamlText.slice(0, at);
  return head.replace(/^allow-lan:[ \t]*true[ \t]*$/m, 'allow-lan: false') + (at < 0 ? '' : yamlText.slice(at));
}

/** MIHOMO_TEMPLATE:空或 all = 全部(默认);off = 关闭;逗号分隔的客户名 = 只对这些生效 */
export function mihomoTemplateMatcher(setting: string): (customerName: string) => boolean {
  const value = setting.trim();
  if (!value || value.toLowerCase() === 'all') return () => true;
  if (['off', 'none', 'false', '0'].includes(value.toLowerCase())) return () => false;
  const names = new Set(value.split(',').map((s) => s.trim()).filter(Boolean));
  return (name) => names.has(name);
}
