// 命令行:逐个客户、逐个节点真实测试能不能连通,出口 IP 对不对。只读,不改任何面板。
// 用法(服务器上):docker compose exec app node server/dist/checkNodes.js [--runner 面板名] [--customer 客户名]
//   --runner   在哪台面板上跑测试(默认第一台启用的落地);测试从那台机器发起,测不出国内线路是否被封
//   --customer 只测这位客户
// 有节点失败时退出码为 1。

import { join } from 'node:path';
import { openDb } from './db';
import { env } from './env';
import { checkNodes, pickRunner } from './nodeCheck';
import { defaultFetcher } from './subscription/service';
import { XUIClient } from './xui/client';

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};

const db = openDb(join(env.dataDir, 'hub.db'));
try {
  const runner = pickRunner(db, arg('runner'));
  const client = new XUIClient(runner, { timeoutMs: 240_000 });
  console.log(`在「${runner.name}」上测试…`);
  const report = await checkNodes(db, {
    runner: runner.name,
    tester: (outbounds) => client.testOutbounds(outbounds),
    fetcher: defaultFetcher({ timeoutMs: 10_000 }),
    customer: arg('customer'),
  });
  await client.close();

  const { results } = report;
  const failed = results.filter((r) => !r.ok);
  const mismatch = results.filter((r) => r.exitMismatch);
  console.log(`${report.customers} 位客户、${results.length} 个节点:连通 ${results.length - failed.length},失败 ${failed.length},出口 IP 和推算不一致 ${mismatch.length}`);
  if (failed.length) {
    console.log('\n失败:');
    for (const r of failed) console.log(`  ${r.customer}${r.state !== 'active' ? `[${r.state}]` : ''} @ ${r.panel} ${r.name}(${r.protocol}):${r.error}`);
  }
  if (mismatch.length) {
    console.log('\n出口 IP 不一致:');
    for (const r of mismatch) console.log(`  ${r.customer} @ ${r.panel} ${r.name}:实际 ${r.egress},推算 ${r.expected.join(' / ')}`);
  }
  if (report.skipped.length) {
    console.log('\n没测到:');
    for (const s of report.skipped) console.log(`  ${s}`);
  }
  process.exitCode = failed.length ? 1 : 0;
} finally {
  db.close();
}
