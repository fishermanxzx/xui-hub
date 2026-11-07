// 面板把配置存成(可能多层的)JSON 字符串。空串 / 不是 JSON 的当作没有,不抛错。

export function decodeJson(v: unknown): any {
  try {
    for (let i = 0; i < 5 && typeof v === 'string'; i++) v = JSON.parse(v);
    return v;
  } catch {
    return undefined;
  }
}

/** POST /xray/ 的返回(或已解出的配置)→ Xray 配置对象 */
export function xrayConfig(raw: unknown): any {
  const env = decodeJson(raw);
  return decodeJson(env?.xraySetting ?? env) ?? {};
}
