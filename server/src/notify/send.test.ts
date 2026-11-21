import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { channelsFor, feishuChannel, feishuSign } from './send';

/** 假的飞书机器人:记下收到的请求体,按 reply 回 */
async function fakeFeishu(reply: (body: any) => object) {
  const got: any[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw);
      got.push(body);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(reply(body)));
    });
  }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/open-apis/bot/v2/hook/abc`;
  return { url, got, close: () => new Promise((r) => server.close(r)) };
}

const msg = { event: 'panel_down', title: '面板「a」连不上', text: '连接失败\n第二行', at: 1 };

test('飞书:按富文本发,标题 + 一行一段;没填密钥不带签名', async () => {
  const f = await fakeFeishu(() => ({ code: 0, msg: 'success', data: {} }));
  try {
    await feishuChannel({ url: f.url, secret: '' }).send(msg);
    assert.deepEqual(f.got[0], {
      msg_type: 'post',
      content: { post: { zh_cn: { title: '面板「a」连不上', content: [[{ tag: 'text', text: '连接失败' }], [{ tag: 'text', text: '第二行' }]] } } },
    });
  } finally {
    await f.close();
  }
});

test('飞书:填了密钥带 timestamp + sign(时间戳\\n密钥 做 key 对空串 HmacSHA256);飞书回 200 但 code 不是 0 算失败', async () => {
  const secret = 'my-secret';
  const f = await fakeFeishu((b) => {
    const ok = b.sign === createHmac('sha256', `${b.timestamp}\n${secret}`).update('').digest('base64');
    return ok ? { StatusCode: 0, StatusMessage: 'success' } : { code: 19021, msg: 'sign match fail or timestamp is not within one hour from current time' };
  });
  try {
    const now = () => 1_700_000_000_123;
    await feishuChannel({ url: f.url, secret }, now).send(msg);
    assert.deepEqual([f.got[0].timestamp, f.got[0].sign], ['1700000000', feishuSign(secret, 1_700_000_000)]);
    await assert.rejects(feishuChannel({ url: f.url, secret: 'wrong' }, now).send(msg), /飞书返回 19021:sign match fail/);
  } finally {
    await f.close();
  }
});

test('渠道:飞书单独一个,和 Telegram、Webhook 并列', () => {
  const base = { telegram: { token: '', chat_id: '' }, webhook: { url: '' } };
  assert.deepEqual(channelsFor({ ...base, feishu: { url: '', secret: '' } }), []);
  assert.deepEqual(
    channelsFor({ telegram: { token: 't', chat_id: 'c' }, webhook: { url: 'https://x' }, feishu: { url: 'https://open.feishu.cn/open-apis/bot/v2/hook/a', secret: '' } }).map((c) => c.name),
    ['Telegram', '飞书', 'Webhook'],
  );
  // 飞书发不了文件(备份只走 Telegram)
  assert.equal(channelsFor({ ...base, feishu: { url: 'https://open.feishu.cn/open-apis/bot/v2/hook/a', secret: '' } })[0].sendFile, undefined);
});
