// Mihomo(Clash Meta)基础模板:替换 subconverter 生成的 Clash 配置头部(proxies: 之前的全局设置)。
// proxies 及之后(节点、策略组、规则)一字不动。默认对所有客户生效,MIHOMO_TEMPLATE=off 关闭。
// 头部照一家在卖的代理商的 Clash 配置抄(它给 Clash 系和 Stash 的是同一份):
// - 不开局域网访问(allow-lan: false),ipv6 关
// - sniffer:从 TLS / HTTP 里嗅出域名,纯 IP 的连接也嗅,只用来匹配规则、不改连接目标
// - profile.store-selected:重启后记住各分组手动选的节点
// - 地理数据用 geoip.dat / geosite.dat,不自动更新;首次下载经 gh-proxy.com 加速(国内直连 GitHub 常下不动)
// - DNS:fake-ip;国外经代理用 DoH 查(respect-rules),国内和局域网域名用国内 DoT;节点域名用国内 DoT 解析

import YAML from 'yaml';

const HEADER = `mixed-port: 7890
allow-lan: false
mode: rule
log-level: silent
ipv6: false
unified-delay: true
tcp-concurrent: true
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
  geoip: "https://gh-proxy.com/https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/geoip.dat"
  geosite: "https://gh-proxy.com/https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/geosite.dat"
  mmdb: "https://gh-proxy.com/https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/country.mmdb"
dns:
  enable: true
  listen: 0.0.0.0:1053
  ipv6: false
  enhanced-mode: fake-ip
  fake-ip-range: 198.18.0.1/16
  fake-ip-filter:
    - "*.lan"
    - "*.local"
    - "+.pool.ntp.org"
    - "time.*.com"
    - "ntp.*.com"
    - "msftconnecttest.com"
    - "msftncsi.com"
  respect-rules: true
  default-nameserver: ['223.5.5.5', '119.29.29.29']
  nameserver: ['https://1.1.1.1/dns-query', 'https://8.8.8.8/dns-query']
  proxy-server-nameserver: ['tls://223.5.5.5:853', 'tls://120.53.53.53:853']
  nameserver-policy:
    'geosite:cn,private': ['tls://223.5.5.5:853', 'tls://120.53.53.53:853']
skip-proxy: ['127.0.0.1', '::1', 'localhost', '192.168.0.0/16', '10.0.0.0/8', '172.16.0.0/12', '100.64.0.0/10']
`;

/** 模板头部自己的键;原头部里这些键以模板为准 */
const HEADER_KEYS = new Set(Object.keys(YAML.parse(HEADER)));

/** 原头部的这些项去掉:端口项会和模板的 mixed-port 抢同一端口;external-controller 模板里没有,照抄就不要 */
const DROP_KEYS = new Set(['port', 'socks-port', 'redir-port', 'tproxy-port', 'mixed-port', 'external-controller']);

export function applyMihomoTemplate(yamlText: string): string {
  const at = yamlText.search(/^proxies:/m);
  if (at < 0) return yamlText;
  let original: unknown;
  try {
    original = YAML.parse(yamlText.slice(0, at)) ?? {};
  } catch {
    return yamlText;
  }
  if (typeof original !== 'object' || Array.isArray(original)) return yamlText;
  // 原头部里模板没覆盖的其他项(自定义规则配置带的 hosts 等)保留在模板之后
  const extras = Object.fromEntries(Object.entries(original as Record<string, unknown>).filter(([k]) => !HEADER_KEYS.has(k) && !DROP_KEYS.has(k)));
  return HEADER + (Object.keys(extras).length ? YAML.stringify(extras, { lineWidth: 0 }) : '') + yamlText.slice(at);
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
