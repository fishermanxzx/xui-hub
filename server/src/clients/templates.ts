// 新建入站用的模板:先照其他面板上已有的同协议入站复制(换新密钥 / 证书),都没有时用内置模板(vless reality / hy2)。
// 结构按 3x-ui v3 的表单默认值(frontend/src/schemas/protocols)写。
// 字段格式与 3x-ui /inbounds/list 返回的一致(settings、streamSettings 等为 JSON 字符串),可以直接提交给 /inbounds/add。

import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { decodeJson } from '../xui/json';

export type ClientProtocol = 'vless' | 'hysteria';

export const streamOf = (ib: any) => decodeJson(ib?.streamSettings) ?? {};
export const isReality = (ib: any) => ib?.protocol === 'vless' && streamOf(ib).network === 'tcp' && streamOf(ib).security === 'reality';
export const isHysteria2 = (ib: any) => ib?.protocol === 'hysteria' && streamOf(ib).security === 'tls';
/** 能当模板的入站:vless 要 reality,hy2 要 tls */
export const isTemplate = (protocol: ClientProtocol) => (ib: any) => (protocol === 'vless' ? isReality(ib) : isHysteria2(ib));

function x25519() {
  const { privateKey, publicKey } = generateKeyPairSync('x25519');
  return { privateKey: privateKey.export({ format: 'jwk' }).d!, publicKey: publicKey.export({ format: 'jwk' }).x! };
}

const shortIds = () => [2, 4, 6, 8, 10, 12, 14, 16].map((n) => randomBytes(n / 2).toString('hex'));

const withStream = (template: any, stream: any) => ({
  ...template,
  streamSettings: typeof template.streamSettings === 'string' ? JSON.stringify(stream) : stream,
  shareAddr: '',
});

/** 别的面板上的 reality 入站当模板时,换上新密钥、新 shortId 和 spiderX */
export function freshReality(template: any): any {
  const stream = structuredClone(streamOf(template));
  const keys = x25519();
  const reality = stream.realitySettings ?? {};
  reality.privateKey = keys.privateKey;
  reality.shortIds = shortIds();
  reality.mldsa65Seed = '';
  reality.settings = { ...(reality.settings ?? {}), publicKey: keys.publicKey, spiderX: `/${randomBytes(12).toString('base64url')}`, mldsa65Verify: '' };
  stream.realitySettings = reality;
  return withStream(template, stream);
}

/** 别的面板上的 hy2 入站当模板时,证书换成这台面板自己用的那份,SNI 填面板地址(面板证书就是签给它的),混淆密码重新生成 */
export function freshHysteria(template: any, cert: { certFile: string; keyFile: string }, serverName: string): any {
  const stream = structuredClone(streamOf(template));
  stream.tlsSettings = {
    ...(stream.tlsSettings ?? {}),
    serverName,
    certificates: [{ certificateFile: cert.certFile, keyFile: cert.keyFile, ocspStapling: 3600, oneTimeLoading: false, usage: 'encipherment', buildChain: false }],
  };
  for (const m of stream.finalmask?.udp ?? []) {
    if (m?.type === 'salamander') m.settings = { ...(m.settings ?? {}), password: randomBytes(12).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g, 'x') };
  }
  return withStream(template, stream);
}

/** 内置的 vless + tcp + reality 入站(伪装 www.microsoft.com),面板上一个入站都没有时用 */
export function builtinVlessReality(): any {
  const keys = x25519();
  return {
    up: 0,
    down: 0,
    total: 0,
    remark: '',
    enable: true,
    expiryTime: 0,
    listen: '',
    port: 0,
    protocol: 'vless',
    settings: JSON.stringify({ clients: [], decryption: 'none', fallbacks: [] }),
    streamSettings: JSON.stringify({
      network: 'tcp',
      security: 'reality',
      externalProxy: [],
      realitySettings: {
        show: false,
        xver: 0,
        target: 'www.microsoft.com:443',
        serverNames: ['www.microsoft.com'],
        privateKey: keys.privateKey,
        minClientVer: '',
        maxClientVer: '',
        maxTimediff: 0,
        shortIds: shortIds(),
        mldsa65Seed: '',
        settings: { publicKey: keys.publicKey, fingerprint: 'chrome', serverName: '', spiderX: '/', mldsa65Verify: '' },
      },
      tcpSettings: { acceptProxyProtocol: false, header: { type: 'none' } },
    }),
    sniffing: JSON.stringify({ enabled: true, destOverride: ['http', 'tls', 'quic', 'fakedns'], metadataOnly: false, routeOnly: false }),
    allocate: JSON.stringify({ strategy: 'always', refresh: 5, concurrency: 3 }),
  };
}

/** 内置的 hysteria2 入站:TLS 用面板自己配置的证书,SNI 填面板地址;不开混淆。面板没配证书时建不了 */
export function builtinHysteria2(cert: { certFile: string; keyFile: string }, serverName: string): any {
  return {
    up: 0,
    down: 0,
    total: 0,
    remark: '',
    enable: true,
    expiryTime: 0,
    listen: '',
    port: 0,
    protocol: 'hysteria',
    settings: JSON.stringify({ version: 2, clients: [] }),
    streamSettings: JSON.stringify({
      network: 'hysteria',
      security: 'tls',
      externalProxy: [],
      hysteriaSettings: { version: 2, auth: '', udpIdleTimeout: 60 },
      tlsSettings: {
        serverName,
        minVersion: '1.2',
        maxVersion: '1.3',
        cipherSuites: '',
        rejectUnknownSni: false,
        disableSystemRoot: false,
        enableSessionResumption: false,
        certificates: [{ certificateFile: cert.certFile, keyFile: cert.keyFile, ocspStapling: 3600, oneTimeLoading: false, usage: 'encipherment', buildChain: false }],
        alpn: ['h3'],
        echServerKeys: '',
        settings: { fingerprint: '', echConfigList: '', pinnedPeerCertSha256: [], verifyPeerCertByName: '' },
      },
    }),
    sniffing: JSON.stringify({ enabled: true, destOverride: ['http', 'tls', 'quic', 'fakedns'], metadataOnly: false, routeOnly: false }),
    allocate: JSON.stringify({ strategy: 'always', refresh: 5, concurrency: 3 }),
  };
}

/** 照模板入站复制一份:换端口和名字,清空 client,不带流量和到期;字段的类型(对象 / JSON 字符串)跟模板一致 */
export function cloneInbound(template: any, port: number, remark: string): any {
  const { id: _id, tag: _tag, originNodeGuid: _g, clientStats: _c, up: _u, down: _d, lastTrafficResetTime: _l, allTime: _a, ...rest } = template;
  const settings = { ...(decodeJson(rest.settings) ?? {}), clients: [] };
  return {
    ...rest,
    port,
    remark,
    enable: true,
    total: 0,
    expiryTime: 0,
    settings: typeof rest.settings === 'string' ? JSON.stringify(settings) : settings,
  };
}
