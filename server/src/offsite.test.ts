import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { gunzipSync } from 'node:zlib';
import { signedPut, uploadBackup, type S3Target } from './offsite';

const target: S3Target = {
  endpoint: 'https://0123456789abcdef.r2.cloudflarestorage.com',
  bucket: 'xui-backup',
  region: 'auto',
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
};

test('签名:路径风格地址,SigV4 签名与 aws4 库算出的一致', () => {
  const { url, headers } = signedPut(target, 'hub-2026-11-03T10-15-30-123Z.db.gz', Buffer.from('hello gzip body'), new Date(Date.UTC(2026, 10, 3, 10, 15, 30, 123)));
  assert.equal(url, 'https://0123456789abcdef.r2.cloudflarestorage.com/xui-backup/hub-2026-11-03T10-15-30-123Z.db.gz');
  assert.equal(headers['x-amz-date'], '20261103T101530Z');
  // R2 页面上抄来的地址带着桶名,结果一样
  const copied = signedPut({ ...target, endpoint: `${target.endpoint}/xui-backup/` }, 'hub-2026-11-03T10-15-30-123Z.db.gz', Buffer.from('hello gzip body'), new Date(Date.UTC(2026, 10, 3, 10, 15, 30, 123)));
  assert.deepEqual(copied, { url, headers });
  assert.equal(
    headers.Authorization,
    'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20261103/auto/s3/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, ' +
      'Signature=1033c1cd0300061b61d7b5bb60b02ee7fe766d9adbce5f0624c592367ebdffb1',
  );
});

test('上传:数据库文件 gzip 后 PUT 到 /<桶>/<文件名>.gz;对方拒绝时报错', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'xm2-offsite-'));
  const got: { method?: string; url?: string; auth?: string; body?: Buffer }[] = [];
  let status = 200;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      got.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: Buffer.concat(chunks) });
      res.statusCode = status;
      res.end(status === 200 ? '' : '<Error><Code>AccessDenied</Code></Error>');
    });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  try {
    const file = join(dir, 'hub-2026-11-03T00-00-00-000Z.db');
    writeFileSync(file, 'sqlite bytes');
    const t = { ...target, endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
    assert.equal(await uploadBackup(t, file), 'hub-2026-11-03T00-00-00-000Z.db.gz');
    assert.equal(got[0].method, 'PUT');
    assert.equal(got[0].url, '/xui-backup/hub-2026-11-03T00-00-00-000Z.db.gz');
    assert.match(got[0].auth!, /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\//);
    assert.equal(gunzipSync(got[0].body!).toString(), 'sqlite bytes');
    status = 403;
    await assert.rejects(uploadBackup(t, file), /HTTP 403 .*AccessDenied/);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
