# README 配图

`docs/images/` 里的截图用这两个脚本生成,数据全是演示用的(example 域名、文档保留 IP):

```bash
cd web && npm run build && cd ..
npm install --no-save puppeteer-core           # 用本机的 Chrome 无头截图
node scripts/screenshots/mock.mjs web/dist 18800 &   # 假接口 + 静态页
node scripts/screenshots/shoot.mjs docs/images 18800
```

`shoot.mjs` 里 Chrome 的路径按 macOS 写的,别的系统改一下 `executablePath`。
