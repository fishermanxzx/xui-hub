import assert from 'node:assert/strict';
import { test } from 'node:test';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { subconverterClient } from './convert';

test('透传转换参数;QX / Loon / Surge 只要节点列表,Surge 默认 ver=4', async () => {
  const seen: Record<string, string>[] = [];
  const app = express();
  app.get('/sub', (req, res) => {
    seen.push(req.query as Record<string, string>);
    res.type('text/plain').send('ok');
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  try {
    const convert = subconverterClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    const out = await convert('clash', 'http://app/nodes', { config: 'MINI.ini', list: 'false' });
    assert.equal(out.body, 'ok');
    assert.deepEqual(seen[0], { config: 'MINI.ini', list: 'false', target: 'clash', url: 'http://app/nodes' });
    await convert('quanx', 'u', { list: 'false' });
    assert.equal(seen[1].list, 'true');
    await convert('surge', 'u', {});
    assert.equal(seen[2].ver, '4');
    assert.equal(seen[2].list, 'true');
  } finally {
    await new Promise((r) => server.close(r));
  }
});
