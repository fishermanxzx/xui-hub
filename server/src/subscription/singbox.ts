// sing-box 配置生成(Hiddify、SFA/SFI/SFM 等)。节点协议:vless / vmess / trojan / hysteria2 / shadowsocks / tuic。结构参照主流面板:
// 两个组(节点选择 / 自动选择),国内域名与 IP 直连、广告拦截,规则集从 SagerNet / Loyalsoldier 远程下载。
// sing-box 1.12 起 DNS 服务器换了新写法(旧写法 1.14 删除),按客户端版本输出对应写法。

import type { ProxyNode, Transport } from './nodes';

const SELECT = '节点选择';
const AUTO = '自动选择';

/** UA 里带 sing-box 版本且低于 1.12 时用旧 DNS 写法;认不出版本(如 Hiddify)用新写法 */
export function singboxLegacyDns(ua: string | undefined): boolean {
  return below(ua, 12);
}

/** UA 里的 sing-box 版本低于 1.minor;认不出版本返回 false */
function below(ua: string | undefined, minor: number): boolean {
  const m = (ua ?? '').match(/sing-box[\s/]+(\d+)\.(\d+)/i);
  return !!m && (Number(m[1]) < 1 || (Number(m[1]) === 1 && Number(m[2]) < minor));
}

/** dns.independent_cache 在 1.14 弃用(1.16 删除,官方说直接去掉):1.14 起不写,更早的和认不出版本的照写 */
export function singboxIndependentCache(ua: string | undefined): boolean {
  return below(ua, 14) || !/sing-box[\s/]+\d+\.\d+/i.test(ua ?? '');
}

const RULE_SETS = [
  ['geosite-geolocation-!cn', 'https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set/geosite-geolocation-!cn.srs'],
  ['geoip-cn', 'https://raw.githubusercontent.com/Loyalsoldier/geoip/release/srs/cn.srs'],
  ['geosite-cn', 'https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set/geosite-cn.srs'],
  ['category-ads-all', 'https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set/geosite-category-ads-all.srs'],
].map(([tag, url]) => ({ tag, type: 'remote', format: 'binary', url, download_detour: SELECT }));

function tls(node: { sni?: string; alpn: string[]; fingerprint?: string }, insecure: boolean): Record<string, unknown> {
  return {
    enabled: true,
    insecure,
    ...(node.sni ? { server_name: node.sni } : {}),
    ...(node.alpn.length ? { alpn: node.alpn } : {}),
    ...(node.fingerprint ? { utls: { enabled: true, fingerprint: node.fingerprint } } : {}),
  };
}

/** tcp 不用写 transport */
function transport(node: Transport): { transport?: Record<string, unknown> } {
  if (node.network === 'ws') return { transport: { type: 'ws', path: node.path ?? '/', ...(node.host ? { headers: { Host: node.host } } : {}) } };
  if (node.network === 'grpc') return { transport: { type: 'grpc', service_name: node.serviceName ?? '' } };
  if (node.network === 'httpupgrade') return { transport: { type: 'httpupgrade', path: node.path ?? '/', ...(node.host ? { host: node.host } : {}) } };
  return {};
}

function outbound(node: ProxyNode, insecure: boolean): Record<string, unknown> {
  const base = { type: node.type, tag: node.name, server: node.server, server_port: node.port };
  if (node.type === 'hysteria2') {
    return {
      ...base,
      password: node.password,
      ...(node.obfs ? { obfs: { type: node.obfs, password: node.obfsPassword ?? '' } } : {}),
      tls: tls(node, insecure || node.insecure),
    };
  }
  if (node.type === 'shadowsocks') {
    const opts = Object.entries(node.pluginOpts ?? {})
      .map(([k, v]) => (v === 'true' && k === 'tls' ? k : `${k}=${v}`))
      .join(';');
    return { type: 'shadowsocks', tag: node.name, server: node.server, server_port: node.port, method: node.method, password: node.password, ...(node.plugin ? { plugin: node.plugin, plugin_opts: opts } : {}) };
  }
  if (node.type === 'tuic') {
    return {
      ...base,
      uuid: node.uuid,
      password: node.password,
      ...(node.congestion ? { congestion_control: node.congestion } : {}),
      ...(node.udpRelayMode ? { udp_relay_mode: node.udpRelayMode } : {}),
      tls: tls({ ...node, alpn: node.alpn.length ? node.alpn : ['h3'] }, insecure || node.insecure),
    };
  }
  if (node.type === 'trojan') return { ...base, password: node.password, tls: tls(node, insecure || node.insecure), ...transport(node) };
  if (node.type === 'vmess') {
    return {
      ...base,
      uuid: node.uuid,
      security: node.cipher,
      alter_id: node.alterId,
      ...(node.tls ? { tls: tls(node, insecure || node.insecure) } : {}),
      ...transport(node),
    };
  }
  const reality = node.security === 'reality' ? { reality: { enabled: true, public_key: node.publicKey ?? '', short_id: node.shortId ?? '' } } : {};
  return {
    ...base,
    uuid: node.uuid,
    packet_encoding: 'xudp',
    ...(node.flow ? { flow: node.flow } : {}),
    ...(node.security === 'none' ? {} : { tls: { ...tls(node, node.insecure), ...reality } }),
    ...transport(node),
  };
}

/**
 * @param insecure hysteria2 / trojan / vmess 是否跳过证书校验(与 subconverter 的 scv 参数一致);vless 只看链接自己带的 allowInsecure,reality 不涉及证书
 */
export function buildSingbox(nodes: ProxyNode[], opts: { legacyDns: boolean; insecure: boolean; independentCache?: boolean }): Record<string, unknown> {
  const tags = nodes.map((n) => n.name);
  // 分组和路由规则是本系统的;DNS、入站(TUN / 本地端口)、日志照一家在卖的代理商的 sing-box 配置抄。
  // DNS:
  // - 国外(remote)用 DoH 并经代理:1.12 起 DNS 服务器不写 detour 就是直连,直连查 1.1.1.1 会被投毒
  //   (实测 www.google.com 解析成假 IP);走 TCP 的 DoH,SOCKS 出口不支持 UDP 时也能用
  // - 国内(cn)用阿里 DoH 直连。节点自己的域名也用它解析:经代理去解析代理的地址会转圈。
  //   1.11 不写 detour 走的是默认出站(也就是代理),所以旧写法要显式写 DIRECT
  // - 只要 IPv4:服务器多数没有 IPv6,给 AAAA 记录会让应用先试 IPv6 再退回,白等一下
  // - independent_cache:国内 / 国外的解析结果分开缓存
  const dns = opts.legacyDns
    ? {
        servers: [
          { tag: 'remote', address: 'https://1.1.1.1/dns-query', detour: SELECT },
          { tag: 'cn', address: 'https://223.5.5.5/dns-query', detour: 'DIRECT' },
        ],
        // 1.11 没有 domain_resolver:出站自己解析服务器地址的查询用 outbound 规则交给国内 DNS
        rules: [
          { outbound: 'any', action: 'route', server: 'cn' },
          { rule_set: ['geosite-cn'], action: 'route', server: 'cn' },
        ],
      }
    : {
        servers: [
          { type: 'https', tag: 'remote', server: '1.1.1.1', detour: SELECT },
          { type: 'https', tag: 'cn', server: '223.5.5.5' },
        ],
        rules: [{ rule_set: ['geosite-cn'], action: 'route', server: 'cn' }],
      };
  return {
    log: { level: 'warn', timestamp: true },
    dns: { ...dns, final: 'remote', ...(opts.independentCache === false ? {} : { independent_cache: true }), strategy: 'ipv4_only' },
    inbounds: [
      { tag: 'tun-in', type: 'tun', address: ['172.19.0.1/30'], auto_route: true, mtu: 9000, stack: 'mixed', strict_route: true },
      { tag: 'mixed-in', type: 'mixed', listen: '127.0.0.1', listen_port: 2080 },
    ],
    outbounds: [
      { tag: 'DIRECT', type: 'direct', ...(opts.legacyDns ? {} : { domain_resolver: { server: 'cn' } }) },
      { tag: SELECT, type: 'selector', interrupt_exist_connections: true, outbounds: [AUTO, ...tags] },
      {
        tag: AUTO,
        type: 'urltest',
        url: 'https://www.gstatic.com/generate_204',
        interval: '10m',
        tolerance: 50,
        idle_timeout: '30m',
        interrupt_exist_connections: false,
        outbounds: tags,
      },
      ...nodes.map((n) => outbound(n, opts.insecure)),
    ],
    route: {
      rules: [
        { action: 'sniff' },
        { protocol: 'dns', action: 'hijack-dns' },
        { rule_set: ['category-ads-all'], action: 'reject', method: 'default', no_drop: false },
        { ip_is_private: true, action: 'route', outbound: 'DIRECT' },
        { clash_mode: '关闭代理', action: 'route', outbound: 'DIRECT' },
        { clash_mode: '全局代理', action: 'route', outbound: SELECT },
        { rule_set: ['geosite-cn', 'geoip-cn'], action: 'route', outbound: 'DIRECT' },
      ],
      auto_detect_interface: true,
      final: SELECT,
      // 节点(出站)的域名用国内 DNS 直连解析
      ...(opts.legacyDns ? {} : { default_domain_resolver: { server: 'cn' } }),
      rule_set: RULE_SETS,
    },
    experimental: {
      cache_file: { enabled: true },
      clash_api: { default_mode: '海外代理', external_controller: '127.0.0.1:9090', secret: '' },
    },
  };
}
