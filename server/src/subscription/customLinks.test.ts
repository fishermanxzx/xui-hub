import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCustomer, deleteCustomer, getCustomer, listCustomers, updateCustomer } from '../customers/repo';
import { memoryDb } from '../testUtil';
import { customerIdByLink, parseCustomLink } from './customLinks';

test('自定义链接:完整网址只取路径和参数;只填路径的补 /;规范化路径和参数', () => {
  assert.deepEqual(parseCustomLink(' https://old.example.com/GetProfile/?token=t&name=profiles/a '), { link: '/GetProfile/?token=t&name=profiles/a', path: '/getprofile', query: 'name=profiles%2Fa&token=t' });
  assert.deepEqual(parseCustomLink('s/zhang'), { link: '/s/zhang', path: '/s/zhang', query: '' });
  // 两个 / 开头不会被当成域名
  assert.equal(parseCustomLink('//evil.example/x').path, '/evil.example/x');
  // 中文路径:显示用编码后的,匹配用解码后的
  const p = parseCustomLink('/订阅/张三');
  assert.equal(p.path, '/订阅/张三');
  assert.equal(p.link, '/%E8%AE%A2%E9%98%85/%E5%BC%A0%E4%B8%89');
});

test('自定义链接:本程序自己用的地址、空的、太长的不收', () => {
  for (const bad of ['/', '/index.html', '/api', '/API/customers', '/mcp', '/oauth/token', '/.well-known/x', '/assets/a.js', '/internal/nodes/1', 'https://x.com/', 'https://x.com/?a=1']) {
    assert.throws(() => parseCustomLink(bad), /本程序自己用的地址/, bad);
  }
  assert.throws(() => parseCustomLink('  '), /不能为空/);
  assert.throws(() => parseCustomLink(`/${'a'.repeat(600)}`), /不能超过/);
  // 只是前缀像的不算
  assert.equal(parseCustomLink('/apix').path, '/apix');
});

test('自定义链接:随客户读写;整组替换;重复的合并;占了别人的链接 / 别人的 /sub/<token> 报错且不改动', () => {
  const db = memoryDb();
  const a = createCustomer(db, { name: 'a', sub_links: ['/s/a', '/S/A/', '', 'https://old.example.com/getprofile?name=profiles/a&token=t'] });
  const b = createCustomer(db, { name: 'b' });
  assert.deepEqual(getCustomer(db, a)!.sub_links, ['/s/a', '/getprofile?name=profiles/a&token=t']);
  assert.deepEqual(getCustomer(db, b)!.sub_links, []);
  assert.deepEqual(
    listCustomers(db).map((c) => c.sub_links),
    [['/s/a', '/getprofile?name=profiles/a&token=t'], []],
  );
  // 参数顺序不同也是同一条
  assert.throws(() => updateCustomer(db, b, { name: 'b2', sub_links: ['/getprofile?token=t&name=profiles%2Fa'] }), /已经配给了客户「a」/);
  assert.equal(getCustomer(db, b)!.name, 'b', '整次修改都没生效');
  // 按行分隔的字符串也行
  updateCustomer(db, b, { sub_links: '/s/b\n/getprofile?name=profiles/b&token=t' });
  assert.deepEqual(getCustomer(db, b)!.sub_links, ['/s/b', '/getprofile?name=profiles/b&token=t']);
  // 不传就不动,空数组清空
  updateCustomer(db, b, { remark: 'x' });
  assert.equal(getCustomer(db, b)!.sub_links.length, 2);
  updateCustomer(db, b, { sub_links: [] });
  assert.deepEqual(getCustomer(db, b)!.sub_links, []);
  // 不能占别的客户生成的链接(自定义链接优先),自己的可以
  const tokenA = getCustomer(db, a)!.sub_token;
  assert.throws(() => updateCustomer(db, b, { sub_links: [`/sub/${tokenA}`] }), /和客户「a」的订阅链接重了/);
  updateCustomer(db, a, { sub_links: [`/sub/${tokenA}`] });
  // 新建时出错整个不建
  assert.throws(() => createCustomer(db, { name: 'c', sub_links: ['/api/x'] }), /本程序自己用的地址/);
  assert.equal(listCustomers(db).length, 2);
  assert.throws(() => updateCustomer(db, b, { sub_links: Array.from({ length: 21 }, (_, i) => `/s/${i}`) }), /最多 20 个/);
  assert.throws(() => updateCustomer(db, b, { sub_links: 5 }), /一组地址/);
  // 删客户连带删掉
  deleteCustomer(db, a);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM sub_links').get() as { n: number }).n, 0);
});

test('自定义链接:按路径和参数找客户,路径不分大小写、忽略末尾 /,多带参数不影响,取参数最多的那条', () => {
  const db = memoryDb();
  const a = createCustomer(db, { name: 'a', sub_links: ['/getprofile?name=profiles/a&token=t', '/s/张三'] });
  const b = createCustomer(db, { name: 'b', sub_links: ['/getprofile?name=profiles/b&token=t'] });
  const c = createCustomer(db, { name: 'c', sub_links: ['/getprofile', '/getprofile?name=profiles/a'] });
  assert.equal(customerIdByLink(db, '/getprofile', 'name=profiles/a&token=t'), a);
  assert.equal(customerIdByLink(db, '/GETPROFILE/', 'token=t&name=profiles%2Fb&target=clash'), b);
  // 参数对不上全的:落到参数少的那条
  assert.equal(customerIdByLink(db, '/getprofile', 'name=profiles/a&token=wrong'), c);
  assert.equal(customerIdByLink(db, '/getprofile', ''), c);
  assert.equal(customerIdByLink(db, '/s/%E5%BC%A0%E4%B8%89', ''), a);
  assert.equal(customerIdByLink(db, '/s/other', ''), undefined);
  // 路径配过、参数对不上:null(按找不到处理,不交给别的路由)
  assert.equal(customerIdByLink(db, '/S/张三x', ''), undefined);
  updateCustomer(db, c, { sub_links: [] });
  assert.equal(customerIdByLink(db, '/getprofile', 'name=profiles/x&token=t'), null);
  assert.equal(customerIdByLink(db, '/api/customers', ''), undefined);
});
