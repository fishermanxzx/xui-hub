// sing-box 配置生成(Hiddify、SFA/SFI/SFM 等)。结构参照主流面板:
// 两个组(节点选择 / 自动选择),国内域名与 IP 直连、广告拦截,规则集从 SagerNet / Loyalsoldier 远程下载。
// sing-box 1.12 起 DNS 服务器换了新写法(旧写法 1.14 删除),按客户端版本输出对应写法。

import type { ProxyNode, Transport } from './nodes';

const SELECT = '节点选择';
const AUTO = '自动选择';

/** UA 里带 sing-box 版本且低于 1.12 时用旧 DNS 写法;认不出版本(如 Hiddify)用新写法 */
export function singboxLegacyDns(ua: string | undefined): boolean {
  const m = (ua ?? '').match(/sing-box[\s/]+(\d+)\.(\d+)/i);
  return !!m && (Number(m[1]) < 1 || (Number(m[1]) === 1 && Number(m[2]) < 12));
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
export function buildSingbox(nodes: ProxyNode[], opts: { legacyDns: boolean; insecure: boolean }): Record<string, unknown> {
  const tags = nodes.map((n) => n.name);
  const dns = opts.legacyDns
    ? { servers: [{ tag: 'remote', address: '1.1.1.1' }, { tag: 'cn', address: '119.29.29.29' }] }
    : { servers: [{ type: 'udp', tag: 'remote', server: '1.1.1.1' }, { type: 'udp', tag: 'cn', server: '119.29.29.29' }] };
  return {
    dns: { ...dns, rules: [{ rule_set: ['geosite-cn'], action: 'route', server: 'cn' }], final: 'remote' },
    inbounds: [
      {
        tag: 'tun-in',
        type: 'tun',
        address: ['172.19.0.1/30', '2001:0470:f9da:fdfa::1/64'],
        auto_route: true,
        mtu: 9000,
        stack: 'system',
        strict_route: true,
        route_exclude_address_set: ['geoip-cn'],
      },
      { tag: 'socks-in', type: 'socks', listen: '127.0.0.1', listen_port: 2333, users: [] },
      { tag: 'mixed-in', type: 'mixed', listen: '127.0.0.1', listen_port: 2334, users: [] },
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
      ...(opts.legacyDns ? {} : { default_domain_resolver: { server: 'remote' } }),
      rule_set: RULE_SETS,
    },
    experimental: {
      cache_file: { enabled: true },
      clash_api: { default_mode: '海外代理', external_controller: '127.0.0.1:9090', secret: '' },
    },
  };
}
