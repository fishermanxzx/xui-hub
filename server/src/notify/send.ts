// 通知渠道:Telegram Bot 和通用 Webhook。发送失败只记日志,不影响主流程。

import { fetch, FormData } from 'undici';

export interface Message {
  /** 事件类型,如 panel_down */
  event: string;
  title: string;
  text: string;
  at: number;
}

export interface Channel {
  name: string;
  send(msg: Message): Promise<void>;
  /** 发文件(备份用);没有的渠道不支持 */
  sendFile?(name: string, data: Buffer, caption: string): Promise<void>;
}

const TIMEOUT = 15000;

async function expectOk(res: { ok: boolean; status: number; text(): Promise<string> }, what: string): Promise<void> {
  if (res.ok) return;
  const body = (await res.text().catch(() => '')).slice(0, 200);
  throw new Error(`${what}返回 ${res.status}:${body}`);
}

export function telegramChannel(cfg: { token: string; chat_id: string }, api = 'https://api.telegram.org'): Channel {
  const base = `${api}/bot${cfg.token}`;
  return {
    name: 'Telegram',
    async send(msg) {
      const res = await fetch(`${base}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: cfg.chat_id, text: `${msg.title}\n${msg.text}`, disable_web_page_preview: true }),
        signal: AbortSignal.timeout(TIMEOUT),
      });
      await expectOk(res, 'Telegram');
    },
    async sendFile(name, data, caption) {
      const form = new FormData();
      form.set('chat_id', cfg.chat_id);
      form.set('caption', caption);
      form.set('document', new Blob([new Uint8Array(data)]), name);
      const res = await fetch(`${base}/sendDocument`, { method: 'POST', body: form, signal: AbortSignal.timeout(60000) });
      await expectOk(res, 'Telegram');
    },
  };
}

/** POST 一份 JSON:{ event, title, text, at };返回 2xx 算成功 */
export function webhookChannel(url: string): Channel {
  return {
    name: 'Webhook',
    async send(msg) {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(msg),
        signal: AbortSignal.timeout(TIMEOUT),
      });
      await expectOk(res, 'Webhook');
    },
  };
}

export function channelsFor(s: { telegram: { token: string; chat_id: string }; webhook: { url: string } }): Channel[] {
  const out: Channel[] = [];
  if (s.telegram.token && s.telegram.chat_id) out.push(telegramChannel(s.telegram));
  if (s.webhook.url) out.push(webhookChannel(s.webhook.url));
  return out;
}

/** 发到所有渠道,返回每个渠道的结果 */
export async function broadcast(channels: Channel[], msg: Message): Promise<{ channel: string; ok: boolean; error?: string }[]> {
  return Promise.all(
    channels.map(async (c) => {
      try {
        await c.send(msg);
        return { channel: c.name, ok: true };
      } catch (e) {
        return { channel: c.name, ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    }),
  );
}
