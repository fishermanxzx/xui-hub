# xui-hub

把多台 3x-ui 面板接进来,在一个后台里给它们创建客户端(vless reality 或 hysteria2),拿到链接和二维码。

Node 22 + Express + SQLite + Vue 3,单容器 Docker 部署。

## 功能

**接入面板**

- 登记 3x-ui 面板:名称、面板地址(含 webBasePath)、API token。保存时立即检查能不能连上,之后每 5 分钟自动检查一次,列表里显示入站数、client 数和连接状态。
- 点进面板看现取的入站(协议、端口、传输方式)和挂在上面的 client(已用流量、到期、最近在线)。只读,不显示任何密钥。

**创建客户端**

- 在面板里「创建客户端」:填名称,选协议 vless(reality,TCP)或 hy2(hysteria2,UDP)。
- 面板上已有这个协议、启用着的入站就直接挂上去(vless 优先 reality 入站,都优先 client 多的);没有就自动新建一个入站:
  - vless:照其他已接入面板上的 reality 入站复制(密钥、shortId 重新生成),一台都没有就用内置模板(伪装 www.microsoft.com,随机端口 20000–59999);建好后探测端口,连不上就删掉并报错。
  - hy2:照其他已接入面板上的 hy2 入站复制,证书换成这台面板自己配置的证书(面板设置里的证书路径),SNI 填面板地址,混淆密码重新生成。面板没配证书、或没有可以照着建的 hy2 入站时报错,先在面板上申请证书或手动建一个 hy2 入站。
- 建好后读回核对,直接给出这个 client 的分享链接(由面板按它的分享设置生成)和二维码,可复制、可保存成图片。
- 每个 client 都能随时再看链接,也能从面板上删除。

## 部署

### 服务器

- 1 核 / 1 GB 内存足够。Debian 12 或 Ubuntu 22.04 / 24.04,装 Docker Engine 和 compose 插件(`curl -fsSL https://get.docker.com | sh`)。
- 出站要能访问各面板的 API 端口;入站开 SSH 和 8788。

### 安装

```bash
# 1. 拉代码
git clone https://github.com/fishermanxzx/xui-hub.git /opt/xui-hub

# 2. 配置
cd /opt/xui-hub
cp .env.example .env && vi .env          # 设置 ADMIN_PASSWORD
mkdir -p data && chown 1000:1000 data    # 容器以 uid 1000(node)运行

# 3. 启动
docker compose up -d --build
docker compose ps          # STATUS 显示 healthy
```

浏览器打开 `http://<服务器 IP>:8788`,用 `ADMIN_PASSWORD` 登录,「添加面板」填上 3x-ui 的地址和 API token(面板设置 → API 里生成),点面板名称进去「创建客户端」。

后台密码走明文 HTTP,登录失败按 IP 限流。要 HTTPS 的话在前面放 Caddy 或 Nginx 反代到 8788,并在 `.env` 里设 `LISTEN_ADDR=127.0.0.1` 只绑本机。

### 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `ADMIN_PASSWORD` | 空 | 后台密码,必须设置 |
| `LISTEN_ADDR` / `HOST_PORT` | `0.0.0.0` / `8788` | 宿主机上监听的地址和端口 |
| `CHECK_INTERVAL_SEC` | `300` | 多久自动检查一次面板连通性(秒) |

### 更新

服务器上执行 `/opt/xui-hub/deploy.sh`(`git pull --ff-only` → 重建并等健康检查)。数据在 `data/hub.db`,只有面板的地址和 token。

## 开发

```bash
cd server && npm install && npm run dev    # http://127.0.0.1:8788
cd web && npm install && npm run dev       # http://127.0.0.1:5174,/api 代理到 8788
cd server && npm test                      # 测试
```

## License

MIT
