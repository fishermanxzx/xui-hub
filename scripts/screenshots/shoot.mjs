// 用本机 Chrome 无头截 README 配图。用法:node shoot.mjs <输出目录> [端口]
import puppeteer from 'puppeteer-core';
const OUT = process.argv[2];
const BASE = `http://127.0.0.1:${process.argv[3] || 18800}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--force-color-profile=srgb', '--hide-scrollbars'] });
const page = await browser.newPage();
const clickText = (text, nth = 0) => page.evaluate((text, nth) => {
  const els = [...document.querySelectorAll('button, a, label')].filter((e) => e.textContent.trim().startsWith(text));
  els[nth]?.click();
  return els.length;
}, text, nth);
// 收在「⋯」菜单里的操作:挨个打开 rows 里的菜单,点第一个以 label 开头的项
const pickMenu = (label, rows) => page.evaluate(async (label, rows) => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  for (const b of document.querySelectorAll(`${rows} button.more`)) {
    b.click();
    await wait(150);
    const item = [...document.querySelectorAll('.action-menu .item')].find((i) => i.textContent.trim().startsWith(label));
    if (item) return item.click(), true;
    b.click();
    await wait(100);
  }
  return false;
}, label, rows);
async function shot(name, { width = 1280, height = 800, hash, before } = {}) {
  await page.setViewport({ width, height, deviceScaleFactor: 2 });
  await page.goto(`${BASE}/#${hash}`, { waitUntil: 'networkidle0' });
  await page.reload({ waitUntil: 'networkidle0' });
  await sleep(300);
  if (before) await before();
  await sleep(500);
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log('saved', name);
}
// 客户页默认是机位图:先截机位图和点开张三的弹窗;开线路 / geo / 拓扑在列表里截,线路展开(都记在 localStorage 里)
await page.goto(`${BASE}/`, { waitUntil: 'networkidle0' });
await page.evaluate(() => localStorage.setItem('xui-hub.customerView', 'seats'));
await shot('customers', { hash: 'customers', height: 520 });
await shot('customer', { hash: 'customers', height: 760, before: async () => {
  await page.evaluate(() => document.getElementById('seat-1')?.click());
  await sleep(400);
} });
await page.evaluate(() => {
  localStorage.setItem('xui-hub.customerView', 'list');
  localStorage.setItem('xui-hub.openCustomerLines', '[1,2,3]');
});
await shot('open-line', { hash: 'customers', height: 900, before: async () => {
  await clickText('开线路', 0);
  await sleep(300);
  // 勾两块面板,一次开两条
  await page.evaluate(() => [...document.querySelectorAll('.modal .batch-list input[type=checkbox]:not(:disabled)')].slice(0, 2).forEach((c) => c.click()));
  await sleep(600);
  await clickText('经 SOCKS');
  await sleep(600);
} });
// 出口规则里的 geo 分类浏览器:张三在香港-1 上那条线路的规则,打开域名框的浏览器,看 netflix 分类
await shot('geo', { hash: 'customers', height: 800, before: async () => {
  await pickMenu('出口规则(', '.line');
  await sleep(300);
  await clickText('浏览 geo 分类', 0);
  await sleep(800);
  await page.evaluate(() => [...document.querySelectorAll('.geo .cat')].find((r) => r.querySelector('.code').textContent === 'netflix')?.querySelector('.cat-main').click());
  await sleep(600);
} });
await shot('topology', { hash: 'customers', height: 700, before: async () => {
  await pickMenu('网络拓扑', '.card > .head');
  await sleep(1200);
} });
await page.evaluate(() => localStorage.setItem('xui-hub.openPanels', '[1]'));
await shot('panels', { hash: 'panels', height: 760 });
await shot('socks', { hash: 'socks', height: 430 });
await browser.close();
