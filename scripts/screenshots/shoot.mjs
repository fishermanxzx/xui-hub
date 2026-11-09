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
await shot('customers', { hash: 'customers', height: 860 });
await shot('open-line', { hash: 'customers', height: 900, before: async () => {
  await clickText('开线路', 0);
  await sleep(300);
  await clickText('中转:');
  await sleep(600);
} });
await shot('topology', { hash: 'customers', height: 700, before: async () => {
  await clickText('网络拓扑', 0);
  await sleep(1200);
} });
await page.evaluate(() => localStorage.setItem('xui-hub.openPanels', '[1]'));
await shot('panels', { hash: 'panels', height: 760 });
await shot('socks', { hash: 'socks', height: 430 });
await browser.close();
