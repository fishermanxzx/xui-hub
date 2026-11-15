# 开放 API

给发卡站、机器人这类程序调用 xui-hub 用。后台页面用的就是同一套接口。

## 鉴权

在后台「设置 → 开放 API」生成令牌(明文只显示一次),每个请求带上:

```
Authorization: Bearer xh_……
```

- 请求和响应都是 JSON,地址前缀是 `https://<后台地址>/api`。
- 出错时状态码是 4xx / 5xx,响应体 `{"error": "原因"}`。400 是参数不对,401 是令牌无效,502 是面板连不上或面板报错。
- 令牌不能调 `/settings`、`/backup`、`/restore`、`/tokens`(返回 403),这些只能在后台登录后操作。
- 同一个 IP 连续带错令牌 10 次,10 分钟内会被拒绝(429)。

## 客户

客户对象的主要字段:

| 字段 | 说明 |
|---|---|
| `id` | 客户 id |
| `name` / `remark` | 名称、备注 |
| `quota_bytes` | 总额度(字节),0 = 不限 |
| `expire_at` | 到期时间(毫秒时间戳),0 = 不限期 |
| `reset_day` | 按月重置流量:0 = 不重置,1-28 = 开启。客户有到期时间时重置日跟着到期日走(每月到期日那一刻,续费后跟着变),这个数只在没有到期时间时当「每月几号 0 点」用 |
| `next_reset_at` | 只读:下次按月重置的时间(毫秒),0 = 没开 |
| `limit_devices` | 能拉订阅的设备数上限,0 = 不限 |
| `sub_devices` | 已经拉过订阅的设备数 |
| `sub_template` | Clash 订阅模板:空 = 默认,内置模板 id,或 https 模板地址 |
| `used` | 已用流量(字节,各线路之和) |
| `state` | `active` 正常 / `expired` 已到期 / `over_quota` 已超额 |
| `sub_token` | 订阅链接是 `https://<后台地址>/sub/<sub_token>` |
| `sub_url` | 配了 `SUB_BASE_URL` 时是完整的订阅链接,否则为 `null` |
| `lines` | 线路列表 |

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/customers` | 全部客户 |
| POST | `/customers` | 新建。请求体:`name`(必填)、`remark`、`quota_bytes`、`expire_at`、`reset_day`、`limit_devices`、`sub_template` |
| PATCH | `/customers/:id` | 修改,只传要改的字段。改了额度 / 到期会立刻停用或恢复他的客户端 |
| POST | `/customers/:id/renew` | 续期。请求体:`days`(1-3650),`reset_usage`(可选,`true` 时顺带把流量清零)。在现在的到期日上加天数,已到期或没设到期日的从现在起算 |
| POST | `/customers/:id/reset-usage` | 把已用流量清零 |
| POST | `/customers/:id/sub-token` | 重置订阅链接,旧链接立即失效 |
| GET | `/customers/:id/devices` | 拉过订阅的设备(`id`、`ua`、`ip`、`first_at`、`last_at`) |
| DELETE | `/customers/:id/devices/:deviceId` | 移除一台设备,让出名额 |
| DELETE | `/customers/:id` | 删除客户,连同他在各面板上的客户端 |

## 线路

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/customers/:id/lines` | 开线路,见下 |
| GET | `/customers/:id/lines/:lineId/links` | 这条线路的分享链接 |
| DELETE | `/customers/:id/lines/:lineId` | 删线路(面板上的客户端一起删);面板连不上时加 `?force=1` 只删记录 |

开直连线路(在 1 号面板上自动选一个 vless 入站,没有就新建):

```json
{ "kind": "direct", "panel_id": 1, "inbound": { "protocol": "vless" } }
```

`inbound` 也可以写 `{ "id": 3 }` 指定已有入站;`protocol` 可选 `vless` 或 `hy2`。

开中转线路(客户端连 1 号面板,流量从 2 号面板出去):

```json
{ "kind": "relay", "panel_id": 1, "inbound": { "protocol": "vless" }, "exit": { "kind": "panel", "panel_id": 2 } }
```

出口也可以是 SOCKS 页登记的代理:`"exit": { "kind": "socks", "socks_id": 1 }`。

返回 `{ "line": {…}, "links": ["vless://…"], "created": {…} }`。

## 其它

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/panels` | 面板列表(拿 `panel_id`) |
| GET | `/panels/:id/inbounds` | 面板上的入站和客户端 |
| POST | `/panels/:id/restart` | 重启面板和 Xray 内核,等两个都恢复才返回(一般十几秒);上面所有客户端会断流几秒 |
| GET | `/socks` | SOCKS 代理列表 |
| GET | `/sub-templates` | 内置的订阅模板 |
| POST | `/sync` | 立即同步全部面板的流量并执行额度 / 到期 |
| GET | `/traffic` | 流量统计。查询参数:`by`(`customer` 按客户,默认;`panel` 按面板),`days`(最近几天,含今天,默认 30,最多 365),`id`(可选:展开这位客户 / 这块面板名下各个客户端;按客户时 `0` 是没归入客户的客户端)。返回 `days`(日期)、`total`(每天的上行 / 下行)、`rows`(每行的 `up`、`down` 和每天的合计 `daily`,按用量从大到小) |

## 例子:卖出一个月的套餐

```bash
API=https://hub.example.com:8788/api
AUTH="Authorization: Bearer xh_……"

# 1. 建客户:100 GB,30 天后到期
EXPIRE=$(( ($(date +%s) + 30*86400) * 1000 ))
curl -s -H "$AUTH" -H 'Content-Type: application/json' \
  -d "{\"name\":\"order-1001\",\"quota_bytes\":107374182400,\"expire_at\":$EXPIRE}" $API/customers
# → {"id":12,"sub_token":"AbCd…",…}

# 2. 给他开一条线路
curl -s -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"kind":"direct","panel_id":1,"inbound":{"protocol":"vless"}}' $API/customers/12/lines

# 3. 把订阅链接发给买家:https://hub.example.com:8788/sub/AbCd…

# 续费一个月并清零流量
curl -s -H "$AUTH" -H 'Content-Type: application/json' -d '{"days":30,"reset_usage":true}' $API/customers/12/renew
```
