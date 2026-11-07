# xui-hub

在多台 3x-ui 面板之上加一层「客户」:一个客户可以有多条线路(不同面板上的 client),**流量额度、到期、状态按客户统一管理**,一条订阅链接拿到全部线路。面板只当执行节点。

Node 22 + Express + SQLite + Vue 3,单容器 Docker 部署,订阅转换用 compose 内的 subconverter。

## 功能

**客户**

- 客户有全局的流量额度、到期日、状态和月费;线路是面板上的 client,通过绑定挂在客户下面。面板上的 client 不设到期日和流量上限,只管启停。
- 每轮同步(默认 60 秒)读各面板 client 的累计流量,算增量按小时记账并累加到客户;面板重置流量、重装、client 重建导致的计数回退会被识别,面板暂时不可达不丢数据。
- 同步后自动停用超额 / 到期 / 停用客户仍启用着的线路;客户回到正常或清零已用时自动重新启用,并清掉面板上残留的到期日 / 流量上限。
- 续费(按自然月顺延,可同时清零已用)、每月按到期日自动重置流量、已用清零同步重置面板计数。
- 开通线路:选一个出口(哪台落地 / 哪个 SOCKS / 中转本机直出),自动在每台中转上通往它的入站里新建 client 并绑定;中转上没有对应入站时可照已有入站新建一个,补上出站和路由规则。也可以把面板上已有的 client 绑到客户。
- 删除客户先删掉他在各面板上的全部 client,再删客户,订阅链接立即失效。
- 总览:活跃客户、月收入、月成本、月利润、近 30 天流量(区分直连落地 / 经中转)、每日流量图(总计 / 按客户 / 按面板)、近期到期名单;各线路的实际落地 IP 按面板配置推算,可按落地 IP 聚合查看。

**订阅**

- 每个客户一条链接 `http://<服务器>:8788/sub/<token>`,token 随机生成,可随时「重置链接」让旧链接失效;可生成二维码。
- 节点每次拉取时从各面板现取,不缓存:线路换了入站马上生效;全部线路都取不到时返回 502,客户端保留原配置。响应头 `subscription-userinfo` 带全局已用 / 额度 / 到期,导入后显示客户名。
- 按客户端 UA 返回格式,`?target=` 可强制指定:

  | 客户端 | 内容 |
  |---|---|
  | Clash Verge / Mihomo / FlClash / ClashMeta / NekoBox / Stash / Shadowrocket | Clash YAML(subconverter + ACL4SSR 规则,可选 Mihomo 头部模板) |
  | Hiddify、sing-box | sing-box JSON(本系统生成,按版本选 DNS 写法) |
  | Quantumult X / Loon | 节点列表(本系统生成) |
  | Surge | 节点列表(subconverter) |
  | v2rayN / v2rayNG / 浏览器等 | base64 节点链接 |

- 记录每次拉取的客户端 UA、来源 IP、格式和结果,客户列表显示近几天用了几个客户端、来自几个 IP,便于发现链接被分享。
- 可选:订阅用单独的域名(经 Cloudflare Tunnel 回源),订阅域名只放行 `/sub/<token>`,后台域名不提供订阅。

**面板**

- 登记 3x-ui 面板(地址、API token、类型:中转 / 落地、月成本、机器到期时间),查看同步状态,点进去看每个入站的协议端口、去向和挂着的 client。
- 配置快照:每小时读一遍各面板的入站、client 和 Xray 配置,有变化才存;面板重装或配置被误删后可按快照恢复(补缺的入站和 client,可选换回 Xray 路由 / 出站)。
- 中转上「开线路」:按客户现在用的落地,在新加的中转上一次把线路补齐。落地上「开通直连」:给经过它的客户直接开一条 vless reality 或 hysteria2 线路。
- 卸载面板:列出会删的客户线路,确认后删 client、解绑、移除面板。
- 节点实测:取每位客户订阅里的真实链接,交给一台面板的 Xray 真连一次,列出失败的节点和出口 IP 不一致的节点。

**SOCKS**

- 登记购买的 SOCKS(月成本),测连通性 / 出口 IP / 地区,查看哪些面板在用;面板上在用但未登记的一键登记。
- 卸载:在每台用它的面板上删掉相关 client、入站、出站和路由规则并重启 Xray,先存快照,出问题可恢复。

**备份**

- 每天自动备份数据库,可选 gzip 后再上传到 S3 兼容对象存储(如 Cloudflare R2);改面板前先存配置快照。

**会改动面板的只有这几处**:开通线路、删除客户 / 卸载面板 / 卸载 SOCKS、续费、已用清零和每月自动重置、按客户状态 / 额度 / 到期启停线路、按快照恢复。改动 client 时以面板导出的完整 client 为底只改相关字段,改完读回核对。同步、订阅、扫描、快照只读。

## 部署

流量记账、限额执行和统一订阅都要求 7×24 在线,部署到一台海外服务器上。

### 服务器

- **配置**:1 核 / 1 GB 内存 / 10–20 GB 磁盘足够,进程内存约 100 MB。Debian 12 或 Ubuntu 22.04 / 24.04,装 Docker Engine 和 compose 插件(`curl -fsSL https://get.docker.com | sh`)。
- **位置**:最好和面板同区域。不要放国内(直连面板不稳定),也不要放在落地机上(落地机常换,且承载客户流量)。
- **网络**:出站要能访问各面板的 API 端口;入站开 SSH 和 8788(后台与订阅都走它)。

### 首次部署

```bash
# 1. 拉代码
git clone https://github.com/fishermanxzx/xui-hub.git /opt/xui-hub

# 2. 配置
cd /opt/xui-hub
cp .env.example .env && vi .env          # 至少设置 ADMIN_PASSWORD、SUB_BASE_URL
mkdir -p data && chown 1000:1000 data    # 容器以 uid 1000(node)运行

# 3. 启动
docker compose up -d --build
docker compose ps          # STATUS 显示 healthy
docker compose logs -f
```

浏览器打开 `http://<服务器 IP>:8788`,用 `ADMIN_PASSWORD` 登录。先在「面板」页添加面板(3x-ui 地址、API token、类型),再在「客户」页新建客户、开通线路、复制订阅链接。客户的订阅链接默认就是 `http://<服务器 IP>:8788/sub/<token>`,不需要域名。

后台密码走明文 HTTP,登录失败按 IP 限流;在意的话用下面的 HTTPS 方案,或者 `LISTEN_ADDR=127.0.0.1` 只绑本机、用 SSH 隧道(`ssh -L 8788:127.0.0.1:8788 root@<服务器>`)访问后台。

### 可选:HTTPS 和独立订阅域名

两项都不是必需的,只在有域名、想把后台和订阅分开时用。

- **后台 HTTPS(Caddy)**:域名 A 记录指向服务器,`.env` 里设 `DOMAIN=<域名>`、`LISTEN_ADDR=127.0.0.1`、`COMPOSE_PROFILES=https`,开放 443,`docker compose up -d`。Caddy 只占 443(不占 80,同机 3x-ui 用 acme.sh 续证书时要用 80),证书经 TLS-ALPN 自动申请续期;不做 http→https 跳转。
- **订阅域名(Cloudflare Tunnel)**:服务器 IP 被墙时订阅仍可更新。Cloudflare Zero Trust 新建隧道,公共主机名指向 `http://app:8788`;`.env` 里设 `CF_TUNNEL_TOKEN`、`SUB_DOMAINS=sub.example.com`、`SUB_BASE_URL=https://sub.example.com`,`COMPOSE_PROFILES` 加上 `tunnel`。订阅域名只放行 `/sub/<token>`,后台域名不提供订阅。

### 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `ADMIN_PASSWORD` | 空 | 后台密码,必须设置 |
| `LISTEN_ADDR` / `HOST_PORT` | `0.0.0.0` / `8788` | 宿主机上监听的地址和端口。用 Caddy 或 Tunnel 时改成 `127.0.0.1` 只绑本机 |
| `SUB_BASE_URL` | 空 | 订阅链接的地址前缀;空 = 用打开后台时的地址。订阅走单独域名时填,如 `https://sub.example.com` |
| `SUB_DOMAINS` | 空 | 订阅专用域名(逗号分隔):只提供订阅,后台与其他路径 404 |
| `DOMAIN` | 空 | 后台 HTTPS 域名(启用 caddy 时必填) |
| `CF_TUNNEL_TOKEN` | 空 | Cloudflare Tunnel token(启用 tunnel 时必填) |
| `MIHOMO_TEMPLATE` | 空 | Clash 输出套 Mihomo 头部模板(dns / tcp-concurrent / unified-delay)的范围:`all` / 逗号分隔的客户名 / 空 = 关闭 |
| `SYNC_INTERVAL_SEC` / `SYNC_CONCURRENCY` | `60` / `8` | 同步间隔(秒)与同时同步的面板数 |
| `HISTORY_DAYS` | `60` | 流量历史(每小时流量、计数回退记录)保留天数;客户已用量不受影响 |
| `SUB_LOG_DAYS` | `7` | 订阅拉取记录保留天数 |
| `BACKUP_KEEP_DAYS` | `7` | `data/backups` 里超过这么多天的数据库备份和面板配置快照删掉(最新 3 个备份、每台面板最近 10 份快照总会留着) |
| `BACKUP_S3_ENDPOINT` / `BACKUP_S3_BUCKET` / `BACKUP_S3_ACCESS_KEY_ID` / `BACKUP_S3_SECRET_ACCESS_KEY` | 空 | 异地备份:四项都填才启用,每天的备份 gzip 后上传到 S3 兼容存储。R2 的 ENDPOINT 为 `https://<账号 ID>.r2.cloudflarestorage.com`,`BACKUP_S3_REGION` 默认 `auto`。只上传不删,远端保留期在存储桶的生命周期规则里设 |
| `TZ_OFFSET_MIN` | `480` | 按天汇总用量的时区偏移(分钟),默认 UTC+8 |

### 日常

- **更新**:服务器上执行 `/opt/xui-hub/deploy.sh`(备份数据库 → `git pull --ff-only` → 重建并等健康检查 → Caddyfile 有变化时热重载)。
- **备份**:服务每天自动备份数据库到 `data/backups/`;手动备份 `docker compose exec app node server/dist/backup.js`。数据库里有全部面板 token、配置快照里的 client 凭据和 SOCKS 账号密码,异地备份的存储桶要设成私有,API token 只给这一个桶的读写权限。
- **节点实测**:`docker compose exec app node server/dist/checkNodes.js`(只读,不改面板),`--runner 面板名` 指定在哪台面板上跑,`--customer 客户名` 只测一位;有失败时退出码为 1。

## License

MIT
