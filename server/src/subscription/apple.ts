// Quantumult X / Loon 的节点列表(作为节点资源导入)。格式参照主流面板,行尾 CRLF。
// 两边都只写得出 tcp 和 ws 传输,grpc / httpupgrade 的节点跳过;Quantumult X 不支持 hysteria2,也跳过。

import type { ProxyNode, Transport } from './nodes';

const CRLF = '\r\n';

type Stream = Exclude<ProxyNode, { type: 'hysteria2' }>;
const writable = (n: ProxyNode): n is Stream => n.type !== 'hysteria2' && (n.network === 'tcp' || n.network === 'ws');

/** vmess 的加密方式由客户端定,服务端都收;这两个客户端只在 iOS 上,auto 选的也是 aes-128-gcm */
const cipher = (scy: string) => (scy === 'none' || scy === 'zero' ? 'none' : 'aes-128-gcm');

const wsHost = (n: Transport & { server: string }) => n.host ?? n.sni ?? n.server;

/** QX:每行 `vless=host:port, ..., tag=名称`,整体 base64 */
export function buildQuantumultX(nodes: ProxyNode[]): string {
  const lines = nodes.filter(writable).map((n) => {
    const ws = (secure: boolean) => [`obfs=${secure ? 'wss' : 'ws'}`, `obfs-host=${wsHost(n)}`, `obfs-uri=${n.path ?? '/'}`];
    if (n.type === 'trojan') {
      const fields = [`trojan=${n.server}:${n.port}`, `password=${n.password}`];
      if (n.network === 'ws') fields.push(...ws(true));
      else fields.push('over-tls=true', ...(n.sni ? [`tls-host=${n.sni}`] : []));
      return [...fields, `tls-verification=${!n.insecure}`, 'fast-open=false', 'udp-relay=false', `tag=${n.name}`].join(',');
    }
    if (n.type === 'vmess') {
      const fields = [`vmess=${n.server}:${n.port}`, `method=${cipher(n.cipher)}`, `password=${n.uuid}`];
      if (n.alterId) fields.push('aead=false');
      if (n.network === 'ws') fields.push(...ws(n.tls));
      else if (n.tls) fields.push('obfs=over-tls', ...(n.sni ? [`obfs-host=${n.sni}`] : []));
      if (n.tls) fields.push(`tls-verification=${!n.insecure}`);
      return [...fields, 'fast-open=false', 'udp-relay=false', `tag=${n.name}`].join(',');
    }
    const secure = n.security !== 'none';
    const fields = [`vless=${n.server}:${n.port}`, 'method=none', `password=${n.uuid}`];
    if (n.network === 'ws') {
      fields.push(...ws(secure));
    } else if (secure) {
      fields.push('obfs=over-tls');
      if (n.security === 'reality') fields.push(`reality-base64-pubkey=${n.publicKey ?? ''}`, `reality-hex-shortid=${n.shortId ?? ''}`);
      if (n.sni) fields.push(`obfs-host=${n.sni}`);
    }
    if (secure && n.insecure) fields.push('tls-verification=false');
    if (n.flow) fields.push(`vless-flow=${n.flow}`);
    return [...fields, 'fast-open=true', `tag=${n.name}`].join(',');
  });
  return lines.length ? Buffer.from(lines.join(CRLF) + CRLF, 'utf8').toString('base64') : '';
}

/** Loon:每行 `名称=类型,host,port,凭据,参数...` */
export function buildLoon(nodes: ProxyNode[], opts: { insecure: boolean }): string {
  const lines = nodes.flatMap((n) => {
    if (n.type === 'hysteria2') {
      const fields = [`${n.name}=Hysteria2`, n.server, String(n.port), n.password];
      if (n.sni) fields.push(`sni=${n.sni}`);
      fields.push(`skip-cert-verify=${opts.insecure || n.insecure}`);
      if (n.obfs === 'salamander' && n.obfsPassword) fields.push(`salamander-password=${n.obfsPassword}`);
      return [fields.join(',')];
    }
    if (!writable(n)) return [];
    const transport = [`transport=${n.network}`, ...(n.network === 'ws' ? [`path=${n.path ?? '/'}`, `host=${wsHost(n)}`] : [])];
    const sni = n.sni ? [`sni=${n.sni}`] : [];
    if (n.type === 'trojan') {
      return [[`${n.name}=trojan`, n.server, String(n.port), `"${n.password}"`, ...transport, ...sni, `skip-cert-verify=${opts.insecure || n.insecure}`].join(',')];
    }
    if (n.type === 'vmess') {
      const fields = [`${n.name}=vmess`, n.server, String(n.port), cipher(n.cipher), `"${n.uuid}"`, ...transport, `alterId=${n.alterId}`, `over-tls=${n.tls}`];
      if (n.tls) fields.push(...sni, `skip-cert-verify=${opts.insecure || n.insecure}`);
      return [fields.join(',')];
    }
    const fields = [`${n.name}=VLESS`, n.server, String(n.port), n.uuid, 'alterId=0'];
    if (n.flow) fields.push(`flow=${n.flow}`);
    if (n.security !== 'none') {
      fields.push('over-tls=true', `skip-cert-verify=${n.insecure}`, ...sni);
      if (n.security === 'reality') fields.push(`public-key=${n.publicKey ?? ''}`, `short-id=${n.shortId ?? ''}`);
    }
    return [[...fields, ...transport].join(',')];
  });
  return lines.length ? lines.join(CRLF) + CRLF : '';
}
