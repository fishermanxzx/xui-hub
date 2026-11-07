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

两种方式二选一,效果一样:默认直接开 `http://<服务器 IP>:8788`,不需要域名。服务器 1 核 / 1 GB 内存足够,Debian 12 或 Ubuntu 22.04 / 24.04;出站要能访问各面板的 API 端口,入站开 SSH 和 8788(云服务器还要在安全组里放行)。

### 方式一:一键脚本

root 执行(支持 Debian / Ubuntu / CentOS / Fedora / Arch 等 systemd 发行版,amd64 和 arm64):

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/fishermanxzx/xui-hub/main/install.sh)
```

脚本从 [GitHub Release](https://github.com/fishermanxzx/xui-hub/releases) 下载按架构打好的包(自带 Node 运行时,服务器上不用装 Node / npm),校验 sha256 后解压到 `/usr/local/xui-hub`,数据和 `.env` 放在 `/etc/xui-hub`,用 systemd 托管(服务名 `xui-hub`,专用用户 `xuihub`)。交互运行时会问后台密码和端口,直接回车就是随机密码 + 8788;`curl | bash` 这类非交互方式下不提问,密码取环境变量 `XUIHUB_PASSWORD`(没有就随机生成并打印),端口取 `XUIHUB_PORT`。装完打印后台地址和密码,ufw / firewalld 开着的话顺手放行端口。后面加版本号可以装指定版本,如 `install.sh v0.1.0`。

之后用 `xui-hub` 命令管理,不带参数是菜单,也可以直接用子命令:

| 命令 | 作用 |
|---|---|
| `xui-hub status` / `xui-hub log` | 运行状态 / 实时日志 |
| `xui-hub update` | 更新到最新版(`xui-hub update v0.2.0` 指定版本) |
| `xui-hub password` / `xui-hub port` | 重设后台密码 / 改端口 |
| `xui-hub settings` | 当前设置 |
| `xui-hub ssl` | SSL 证书管理:给域名或 IP 申请 Let's Encrypt 证书(也可走 Cloudflare DNS),设给 xui-hub 后台就变成 HTTPS,acme.sh 自动续期后自动重启。做法和 3x-ui 的 `x-ui` 菜单一致 |
| `xui-hub start` / `stop` / `restart` / `enable` / `disable` | 启停与开机自启 |
| `xui-hub uninstall` | 卸载,会问要不要保留数据目录 |

### 方式二:Docker

镜像预构建好推在 `ghcr.io/fishermanxzx/xui-hub`(amd64 / arm64),不用克隆仓库:

```bash
mkdir -p /opt/xui-hub && cd /opt/xui-hub
curl -fsSLO https://raw.githubusercontent.com/fishermanxzx/xui-hub/main/docker-compose.yml
echo "ADMIN_PASSWORD=$(tr -dc 'A-Za-z0-9' </dev/urandom | head -c 16)" > .env && cat .env   # 或自己写一个密码
mkdir -p data && chown 1000:1000 data    # 容器以 uid 1000(node)运行
docker compose up -d
docker compose ps                        # STATUS 显示 healthy
```

更新:`docker compose pull && docker compose up -d`。`.env` 里还可以设 `LISTEN_ADDR` / `HOST_PORT`(见下)。想自己从源码构建就克隆仓库,把 compose 里的 `image:` 换成 `build: .`。

### 之后

浏览器打开 `http://<服务器 IP>:8788`,用后台密码登录,「添加面板」填上 3x-ui 的地址和 API token(面板设置 → API 里生成),点面板名称进去「创建客户端」。

数据只有 `data/hub.db` 一个文件(面板的地址和 token),备份它就够。

**HTTPS**:默认是明文 HTTP(登录失败按 IP 限流)。一键脚本装的用 `xui-hub ssl` 申请证书:没域名就选「IP 证书」(Let's Encrypt 给 IP 签 6 天短证书,自动续),有域名选域名证书或 Cloudflare DNS 验证;申请完会问要不要设给 xui-hub,设了就直接 HTTPS。Docker 装的把现成的证书目录挂进容器(compose 里 `./cert:/cert:ro`),`.env` 填 `TLS_CERT_FILE=/cert/fullchain.pem` 和 `TLS_KEY_FILE=/cert/privkey.pem`。也可以不管这些,前面放 Caddy / Nginx 反代。

### 环境变量(`.env`,两种方式通用;一键脚本的在 `/etc/xui-hub/.env`)

| 变量 | 默认 | 说明 |
|---|---|---|
| `ADMIN_PASSWORD` | 空 | 后台密码,必须设置(一键脚本会自动生成) |
| `LISTEN_ADDR` / `HOST_PORT` | `0.0.0.0` / `8788` | 监听的地址和端口 |
| `CHECK_INTERVAL_SEC` | `300` | 多久自动检查一次面板连通性(秒) |
| `TLS_CERT_FILE` / `TLS_KEY_FILE` | 空 | 两项都填就直接提供 HTTPS(fullchain 和私钥的路径);`xui-hub ssl` 会自动写 |

## 开发

```bash
cd server && npm install && npm run dev    # http://127.0.0.1:8788
cd web && npm install && npm run dev       # http://127.0.0.1:5174,/api 代理到 8788
cd server && npm test                      # 测试
```

发版:打 tag(`git tag v0.1.0 && git push origin v0.1.0`),GitHub Actions 会构建 amd64 / arm64 两个发布包创建 Release,并把多架构镜像推到 `ghcr.io/fishermanxzx/xui-hub`(`:0.1.0`、`:0.1`、`:latest`);本地打包用 `scripts/build-release.sh amd64 v0.1.0`。

## License

MIT
