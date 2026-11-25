import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addLine, createCustomer, getCustomer, getLine } from '../customers/repo';
import type { DB } from '../db';
import { routeUserToExit } from '../lines/relay';
import { dailyBilled, recordTraffic, trafficReport } from '../traffic/daily';
import { addPanel, fakePanels, memoryDb, relayXray, vlessInbound, type FakePanel } from '../testUtil';
import { createPanel, getPanel, listPanels, updatePanel } from './repo';
import { uninstallPanel } from './uninstall';

const NOW = new Date(2026, 10, 20, 12).getTime();
const GB = 1024 ** 3;

/**
 * 一块倍率 1.5 的面板 old:zhang 两条线路(一条直出、一条走 SOCKS 的中转),li 一条;面板上还有一个没归入客户的客户端 free。
 * 各线路本期用了 1 GB,今天的流量记录里 zhang 的直出线路用了 2 GB
 */
function setup() {
  const db = memoryDb();
  const p = addPanel(db, 'old');
  updatePanel(db, p.id, { traffic_ratio: 1.5 });
  const zhang = createCustomer(db, { name: 'zhang' });
  const li = createCustomer(db, { name: 'li' });
  const base = { panel_id: p.id, inbound_id: 7, inbound_remark: 'v7', protocol: 'vless' };
  const lines = [
    addLine(db, { ...base, customer_id: zhang, kind: 'direct', email: 'zhang-1' }),
    addLine(db, { ...base, customer_id: zhang, kind: 'relay', email: 'zhang-2', exit_kind: 'socks', exit_socks_id: null, exit_label: 'isp' }),
    addLine(db, { ...base, customer_id: li, kind: 'direct', email: 'li-1' }),
  ];
  db.prepare('UPDATE lines SET up = ?, down = 0 WHERE panel_id = ?').run(GB, p.id);
  const xray = relayXray();
  routeUserToExit(xray, 'in-443', 'zhang-2', { address: 'isp.example', port: 1080, user: 'u', pass: 'p' });
  const data: Record<string, FakePanel> = {
    old: {
      inbounds: [vlessInbound(7, 443)],
      clients: ['zhang-1', 'zhang-2', 'li-1', 'free'].map((email) => ({ id: `uuid-${email}`, email, enable: true })),
      xray,
      restarts: 0,
    },
  };
  recordTraffic(db, p.id, [{ email: 'zhang-1', up: 0, down: 0 }], NOW - 1000);
  recordTraffic(db, p.id, [{ email: 'zhang-1', up: 2 * GB, down: 0 }], NOW);
  return { db, p, zhang, li, lines, data };
}

const emails = (d: FakePanel) => d.clients.map((c) => c.email);
const userRules = (d: FakePanel) => (d.xray.routing?.rules ?? []).filter((r: any) => Array.isArray(r.user));
const removed = (db: DB) => db.prepare('SELECT id, name, traffic_ratio FROM removed_panels').all();

test('卸载连得上的面板:先删线路在面板上的客户端和出口规则,再删线路和面板;已用不变,流量历史按原名、原倍率', async () => {
  const { db, p, zhang, li, lines, data } = setup();
  const usedBefore = [getCustomer(db, zhang)!.used, getCustomer(db, li)!.used];

  const r = await uninstallPanel(db, p.id, fakePanels(data));
  assert.deepEqual(r, { name: 'old', lines: 3, customers: 2, remote: 'deleted', clients_deleted: 3, error: '' });
  // 面板上:线路的客户端没了,不是线路的 free 和入站都还在;中转线路的规则去掉了(重启一次 Xray)
  assert.deepEqual(emails(data.old), ['free']);
  assert.equal(data.old.inbounds.length, 1);
  assert.deepEqual(userRules(data.old), []);
  assert.equal(data.old.restarts, 1);
  // 这里:面板和线路记录没了,客户还在、已用不变(本期用的结转了)
  assert.equal(getPanel(db, p.id), undefined);
  assert.ok(lines.every((l) => getLine(db, l.id) === undefined));
  assert.deepEqual(getCustomer(db, zhang)!.lines, []);
  assert.deepEqual([getCustomer(db, zhang)!.used, getCustomer(db, li)!.used], usedBefore);
  // 名字和倍率留着:流量页按原名显示(标成卸载),自助页每天用量按 1.5 算
  assert.deepEqual(removed(db), [{ id: p.id, name: 'old', traffic_ratio: 1.5 }]);
  const report = trafficReport(db, { by: 'panel', days: 7 }, NOW);
  assert.deepEqual(
    report.rows.map((x) => [x.id, x.name, x.deleted, x.uninstalled, x.up]),
    [[p.id, 'old', true, true, 2 * GB]],
  );
  assert.equal(trafficReport(db, { by: 'customer', days: 7, id: zhang }, NOW).rows[0].name, 'old · zhang-1');
  assert.equal(dailyBilled(db, zhang, 7, NOW).bytes.at(-1), 3 * GB);
  // id 不复用;同名的新面板可以再加,流量记录不会串过去
  const fresh = createPanel(db, { name: 'old', base_url: 'https://new.example:2053/x', token: 't' });
  assert.ok(fresh.id > p.id);
  assert.deepEqual(
    trafficReport(db, { by: 'panel', days: 7 }, NOW).rows.map((x) => [x.id, x.uninstalled]),
    [[p.id, true]],
  );
});

test('卸载连不上的面板:直接删记录,面板上的客户端不管;原因写在结果里', async () => {
  const { db, p, lines, data } = setup();
  data.old.fail = { listClients: new Error('connect ECONNREFUSED') };
  const r = await uninstallPanel(db, p.id, fakePanels(data));
  assert.deepEqual([r.remote, r.lines, r.customers, r.clients_deleted], ['unreachable', 3, 2, 0]);
  assert.match(r.error, /ECONNREFUSED/);
  assert.deepEqual(emails(data.old), ['zhang-1', 'zhang-2', 'li-1', 'free']);
  assert.equal(getPanel(db, p.id), undefined);
  assert.ok(lines.every((l) => getLine(db, l.id) === undefined));
  assert.equal(removed(db).length, 1);
});

test('连得上但删到一半失败:报错,面板和线路都留着;再卸载一次接着删;一直删不掉可以只删记录', async () => {
  const { db, p, lines, data } = setup();
  let calls = 0;
  const flaky = fakePanels(data);
  const adminFor = (panel: Parameters<typeof flaky>[0]) => {
    const admin = flaky(panel);
    const del = admin.deleteClient.bind(admin);
    admin.deleteClient = async (email) => {
      if (++calls === 2) throw new Error('面板返回 500');
      return del(email);
    };
    return admin;
  };
  await assert.rejects(uninstallPanel(db, p.id, adminFor), /连得上,但没删完上面的客户端\(这次删了 1 个\):面板返回 500/);
  assert.ok(getPanel(db, p.id));
  assert.equal(listPanels(db).length, 1);
  assert.ok(lines.every((l) => getLine(db, l.id)));
  assert.deepEqual(removed(db), []);
  assert.deepEqual(emails(data.old), ['zhang-2', 'li-1', 'free']);

  // 再来一次:已经删掉的跳过,剩下的接着删
  const again = await uninstallPanel(db, p.id, adminFor);
  assert.deepEqual([again.remote, again.clients_deleted], ['deleted', 2]);
  assert.deepEqual(emails(data.old), ['free']);
  assert.equal(getPanel(db, p.id), undefined);
});

test('只删记录(force):不连面板;面板上没有线路时也不连', async () => {
  const forced = setup();
  forced.data.old.fail = { listClients: '不该连面板', deleteClient: '不该连面板' };
  const r = await uninstallPanel(forced.db, forced.p.id, fakePanels(forced.data), { force: true });
  assert.deepEqual([r.remote, r.lines], ['skipped', 3]);
  assert.equal(getPanel(forced.db, forced.p.id), undefined);
  assert.equal(forced.data.old.clients.length, 4);

  const db = memoryDb();
  const empty = addPanel(db, 'empty');
  const data: Record<string, FakePanel> = { empty: { inbounds: [], clients: [], xray: {}, restarts: 0, fail: { listClients: '不该连面板' } } };
  assert.deepEqual(await uninstallPanel(db, empty.id, fakePanels(data)), { name: 'empty', lines: 0, customers: 0, remote: 'none', clients_deleted: 0, error: '' });
  assert.equal(getPanel(db, empty.id), undefined);
  await assert.rejects(uninstallPanel(db, empty.id, fakePanels(data)), /面板不存在/);
});
