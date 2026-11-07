// Quantumult X / Loon 的节点列表(作为节点资源导入)。格式参照主流面板,行尾 CRLF。
// Quantumult X 不支持 hysteria2,跳过;trojan 的 grpc 两边都不支持,跳过。

import type { ProxyNode } from './nodes';

const CRLF = '\r\n';

/** QX:每行 `vless=host:port, ..., tag=名称`,整体 base64 */
export function buildQuantumultX(nodes: ProxyNode[]): string {
  const lines: string[] = [];
  for (const n of nodes) {
    if (n.type === 'trojan') {
      if (n.network === 'grpc') continue;
      const fields = [`trojan=${n.server}:${n.port}`, `password=${n.password}`];
      if (n.network === 'ws') {
        fields.push('obfs=wss', `obfs-host=${n.host ?? n.sni ?? n.server}`, `obfs-uri=${n.path ?? '/'}`);
      } else {
        fields.push('over-tls=true');
        if (n.sni) fields.push(`tls-host=${n.sni}`);
      }
      fields.push(`tls-verification=${!n.insecure}`, 'fast-open=false', 'udp-relay=false', `tag=${n.name}`);
      lines.push(fields.join(','));
      continue;
    }
    if (n.type !== 'vless') continue;
    const fields = [`vless=${n.server}:${n.port}`, 'method=none', `password=${n.uuid}`];
    if (n.security === 'reality' || n.security === 'tls') {
      fields.push('obfs=over-tls');
      if (n.security === 'reality') fields.push(`reality-base64-pubkey=${n.publicKey ?? ''}`, `reality-hex-shortid=${n.shortId ?? ''}`);
      if (n.sni) fields.push(`obfs-host=${n.sni}`);
    }
    if (n.flow) fields.push(`vless-flow=${n.flow}`);
    fields.push('fast-open=true', `tag=${n.name}`);
    lines.push(fields.join(','));
  }
  return lines.length ? Buffer.from(lines.join(CRLF) + CRLF, 'utf8').toString('base64') : '';
}

/** Loon:每行 `名称=类型,host,port,凭据,参数...` */
export function buildLoon(nodes: ProxyNode[], opts: { insecure: boolean }): string {
  const lines = nodes.flatMap((n) => {
    if (n.type === 'trojan') {
      if (n.network === 'grpc') return [];
      const fields = [`${n.name}=trojan`, n.server, String(n.port), `"${n.password}"`, `transport=${n.network}`];
      if (n.network === 'ws') fields.push(`path=${n.path ?? '/'}`, `host=${n.host ?? n.sni ?? n.server}`);
      if (n.sni) fields.push(`sni=${n.sni}`);
      fields.push(`skip-cert-verify=${opts.insecure || n.insecure}`);
      return [fields.join(',')];
    }
    if (n.type === 'vless') {
      const fields = [`${n.name}=VLESS`, n.server, String(n.port), n.uuid, 'alterId=0'];
      if (n.flow) fields.push(`flow=${n.flow}`);
      if (n.security === 'reality' || n.security === 'tls') {
        fields.push('over-tls=true', 'skip-cert-verify=false');
        if (n.sni) fields.push(`sni=${n.sni}`);
        if (n.security === 'reality') fields.push(`public-key=${n.publicKey ?? ''}`, `short-id=${n.shortId ?? ''}`);
      }
      fields.push(`transport=${n.network}`);
      return fields.join(',');
    }
    const fields = [`${n.name}=Hysteria2`, n.server, String(n.port), n.password];
    if (n.sni) fields.push(`sni=${n.sni}`);
    fields.push(`skip-cert-verify=${opts.insecure || n.insecure}`);
    if (n.obfs === 'salamander' && n.obfsPassword) fields.push(`salamander-password=${n.obfsPassword}`);
    return fields.join(',');
  });
  return lines.length ? lines.join(CRLF) + CRLF : '';
}
