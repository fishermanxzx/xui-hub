import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gunzipSync } from 'node:zlib';
import { DeleteObjectsCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand } from '@aws-sdk/client-s3';
import { inspectBackup } from './backup';
import { downloadBackup, errorText, listRemote, prefixOf, pruneRemote, remoteEnabled, remoteStatus, runRemoteBackup, type RemoteConfig, type S3Like } from './remoteBackup';
import { addPanel, memoryDb } from './testUtil';

const cfg = (over: Partial<RemoteConfig> = {}): RemoteConfig => ({ endpoint: 'https://x.r2.cloudflarestorage.com', region: 'auto', bucket: 'b', access_key: 'ak', secret_key: 'sk', prefix: '/xui-hub/', keep_days: 30, ...over });

/** 假的对象存储:内存里一个 Map,按命令类型响应 */
function fakeS3(objects: Map<string, { body: Buffer; at: number }>) {
  const calls: string[] = [];
  const client: S3Like = {
    async send(cmd: any) {
      calls.push(cmd.constructor.name);
      if (cmd instanceof PutObjectCommand) {
        objects.set(cmd.input.Key!, { body: Buffer.from(cmd.input.Body as Buffer), at: Date.now() });
        return {};
      }
      if (cmd instanceof ListObjectsV2Command) {
        const all = [...objects].filter(([k]) => k.startsWith(cmd.input.Prefix ?? '')).sort(([a], [b]) => a.localeCompare(b));
        // 故意每页 2 个,测分页
        const start = Number(cmd.input.ContinuationToken ?? 0);
        const page = all.slice(start, start + 2);
        return { Contents: page.map(([Key, v]) => ({ Key, Size: v.body.length, LastModified: new Date(v.at) })), IsTruncated: start + 2 < all.length, NextContinuationToken: String(start + 2) };
      }
      if (cmd instanceof DeleteObjectsCommand) {
        for (const o of cmd.input.Delete!.Objects!) objects.delete(o.Key!);
        return {};
      }
      if (cmd instanceof GetObjectCommand) {
        const o = objects.get(cmd.input.Key!);
        if (!o) throw Object.assign(new Error('The specified key does not exist.'), { name: 'NoSuchKey' });
        return { Body: { transformToByteArray: async () => new Uint8Array(o.body) } };
      }
      throw new Error(`unexpected ${cmd.constructor.name}`);
    },
  };
  return { client, calls };
}

test('异地备份:配置判断与前缀规范化', () => {
  assert.equal(remoteEnabled(cfg()), true);
  assert.equal(remoteEnabled(cfg({ secret_key: '' })), false);
  assert.equal(prefixOf(cfg()), 'xui-hub/');
  assert.equal(prefixOf(cfg({ prefix: '' })), '');
  assert.equal(prefixOf(cfg({ prefix: 'a/b' })), 'a/b/');
});

test('异地备份:上传 gzip 的库、记状态、能下载回来恢复', async () => {
  const db = memoryDb();
  addPanel(db, 'p1');
  const objects = new Map<string, { body: Buffer; at: number }>();
  const { client, calls } = fakeS3(objects);
  const now = new Date(2026, 10, 16, 3, 5).getTime();
  const r = await runRemoteBackup(db, cfg(), now, client);
  assert.equal(r.key, 'xui-hub/xui-hub-20261116-0305.db.gz');
  assert.equal(objects.size, 1);
  assert.equal(r.size, objects.get(r.key)!.body.length);
  assert.ok(calls.includes('PutObjectCommand'));
  const st = remoteStatus(db)!;
  assert.deepEqual([st.ok, st.key, st.at], [true, r.key, now]);
  // 解开就是一份能认的库
  const raw = gunzipSync(objects.get(r.key)!.body);
  assert.equal(inspectBackup(raw).panels, 1);
  assert.deepEqual(await downloadBackup(cfg(), r.key, client), raw);
  // 不是本程序的文件不下载
  await assert.rejects(downloadBackup(cfg(), 'xui-hub/other.db.gz', client), /不是本程序的备份/);
  await assert.rejects(downloadBackup(cfg(), 'elsewhere/xui-hub-20261116-0305.db.gz', client), /不是本程序的备份/);
});

test('异地备份:列表按时间倒序、分页;清理只删过期的且至少留 3 份、不碰别的文件', async () => {
  const objects = new Map<string, { body: Buffer; at: number }>();
  const { client } = fakeS3(objects);
  const day = 86_400_000;
  const now = new Date(2026, 10, 16, 12, 0).getTime();
  const put = (d: string, t: string, at: number) => objects.set(`xui-hub/xui-hub-${d}-${t}.db.gz`, { body: Buffer.from('x'), at });
  put('20261116', '0300', now);
  put('20261115', '0300', now - day);
  put('20261001', '0300', now - 46 * day);
  put('20260901', '0300', now - 76 * day);
  put('20260801', '0300', now - 107 * day);
  objects.set('xui-hub/notes.txt', { body: Buffer.from('keep'), at: now - 400 * day });
  objects.set('xui-hub/hub.db.bak', { body: Buffer.from('keep'), at: now - 400 * day });

  const files = await listRemote(cfg(), client);
  assert.deepEqual(
    files.map((f) => f.key.slice(16, 29)),
    ['20261116-0300', '20261115-0300', '20261001-0300', '20260901-0300', '20260801-0300'],
  );

  // 30 天:过期的是 1001 / 0901 / 0801,但要留 3 份 → 只删最老的两份
  assert.equal(await pruneRemote(cfg({ keep_days: 30 }), now, client), 2);
  assert.deepEqual([...objects.keys()].sort(), ['xui-hub/hub.db.bak', 'xui-hub/notes.txt', 'xui-hub/xui-hub-20261001-0300.db.gz', 'xui-hub/xui-hub-20261115-0300.db.gz', 'xui-hub/xui-hub-20261116-0300.db.gz']);
  // 0 = 不清理
  assert.equal(await pruneRemote(cfg({ keep_days: 0 }), now + 1000 * day, client), 0);
  assert.equal(objects.size, 5);
});

test('异地备份:失败记下错误;鉴权错误有直白提示', async () => {
  const db = memoryDb();
  const client: S3Like = {
    async send() {
      throw Object.assign(new Error('The request signature we calculated does not match'), { name: 'SignatureDoesNotMatch', $metadata: { httpStatusCode: 403 } });
    },
  };
  await assert.rejects(runRemoteBackup(db, cfg(), Date.now(), client), /SignatureDoesNotMatch/);
  const st = remoteStatus(db)!;
  assert.equal(st.ok, false);
  assert.match(st.error!, /鉴权失败/);
  assert.match(errorText(Object.assign(new Error('nope'), { name: 'NoSuchBucket' })), /桶不存在/);
  assert.equal(errorText(new Error('connect ECONNREFUSED')), 'connect ECONNREFUSED');
});
