import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCustomer, getCustomer, updateCustomer } from '../customers/repo';
import { memoryDb } from '../testUtil';
import { DEFAULT_TEMPLATE, TEMPLATES, templateUrl, validTemplate } from './templates';

test('订阅模板:空 / 默认 id 存成空;内置 id 原样;自定义只收 https;取地址时空 = 默认模板', () => {
  assert.equal(validTemplate(''), '');
  assert.equal(validTemplate(DEFAULT_TEMPLATE), '');
  assert.equal(validTemplate('ACL4SSR_Online_Full'), 'ACL4SSR_Online_Full');
  assert.equal(validTemplate(' https://x.example/my.ini '), 'https://x.example/my.ini');
  assert.throws(() => validTemplate('http://x.example/my.ini'), /https/);
  assert.throws(() => validTemplate('nope'), /内置/);
  assert.match(templateUrl(''), /ACL4SSR_Online_Mini\.ini$/);
  assert.match(templateUrl('ACL4SSR_Online_Full'), /ACL4SSR_Online_Full\.ini$/);
  assert.equal(templateUrl('https://x.example/my.ini'), 'https://x.example/my.ini');
  assert.equal(TEMPLATES[0].id, DEFAULT_TEMPLATE);
  assert.equal(new Set(TEMPLATES.map((t) => t.id)).size, TEMPLATES.length);
});

test('客户的模板:新建默认空,可改可清,没传不动', () => {
  const db = memoryDb();
  const id = createCustomer(db, { name: 'c' });
  assert.equal(getCustomer(db, id)!.sub_template, '');
  updateCustomer(db, id, { sub_template: 'ACL4SSR_Online' });
  updateCustomer(db, id, { remark: 'x' });
  assert.equal(getCustomer(db, id)!.sub_template, 'ACL4SSR_Online');
  updateCustomer(db, id, { sub_template: '' });
  assert.equal(getCustomer(db, id)!.sub_template, '');
  assert.throws(() => updateCustomer(db, id, { sub_template: 'bad' }));
});
