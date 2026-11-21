# 开放 API

给发卡站、机器人这类程序调用 xui-hub 用。后台页面用的就是同一套接口。

## 鉴权

在后台「设置 → 开放 API」生成令牌(明文只显示一次),每个请求带上:

```
Authorization: Bearer xh_……
```

- 请求和响应都是 JSON,地址前缀是 `https://<后台地址>/api`。
- 出错时状态码是 4xx / 5xx,响应体 `{"error": "原因"}`。400 是参数不对,401 是令牌无效,502 是面板连不上或面板报错。
- 令牌不能调 `/settings`、`/backup`、`/restore`、`/tokens`、`/system`(返回 403),这些只能在后台登录后操作。
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
| `monthly_fee` | 月费(每月收这位客户多少),`null` = 没填;只用来记账,不影响任何功能。写的时候传 `null` 或空字符串 = 清掉 |
| `sub_devices` | 已经拉过订阅的设备数 |
| `sub_template` | Clash 订阅模板:空 = 默认,内置模板 id,或 https 模板地址 |
| `traffic_ratio` | 流量倍率,默认 1(0.01-100,两位小数):计费用量 = 实际流量 × 倍率。写的时候传空 = 1 |
| `actual_up` / `actual_down` / `actual_used` | 只读:本期实际流量(字节)= 各线路之和 + 结转 |
| `carried_up` / `carried_down` | 只读:结转的实际流量(字节):删掉的线路本期用掉的、面板上计数被清零或重建前的、手动调整的;清零时一起清。手动减过时可以是负数 |
| `used_up` / `used_down` / `used` | 只读:本期计费用量(字节)= 实际 × 倍率。订阅里的 `subscription-userinfo`、自助页、额度判断(超额停用)、用量提醒都按它 |
| `state` | `active` 正常 / `expired` 已到期 / `over_quota` 已超额 |
| `sub_token` | 订阅链接是 `https://<后台地址>/sub/<sub_token>` |
| `sub_url` | 配了 `SUB_BASE_URL` 时是完整的订阅链接,否则为 `null` |
| `sub_links` | 自定义订阅链接:路径(可带参数)的数组,如 `/s/zhangsan`、`/getprofile?name=a&token=b`。访问 `https://<订阅地址>/<路径>` 和访问 `sub_url` 一样。路径不分大小写、忽略末尾的 `/`;链接里写了的参数请求里要有且相等,多带的参数不影响。新建 / 修改时传数组整组替换(也可以传完整网址,只取路径和参数),空数组 = 清空;每位客户最多 20 个,不能和别的客户重复,不能占用 `/api`、`/mcp`、`/assets` 等本程序自己用的路径。重置订阅链接不影响它们 |
| `upstreams` | 外部订阅。读出来每项是 `url`、`node_name`(节点名,空 = 用对方的)、`names`(订阅里的节点名,改名之后的,最多 100 个)、`nodes`(上次取到的节点数)、`skipped`(协议不支持、没出的节点数)、`userinfo`(那边给的流量和到期:`upload` / `download` / `total` 字节,`expire` 秒)、`ok_at` / `tried_at`(上次成功 / 上次尝试,毫秒)、`error`(上次没取到的原因) |
| `upstreams`(写) | 新建 / 修改时整组替换,空数组 = 清空,最多 10 个。每项是地址字符串,或 `{ "url": "...", "node_name": "..." }`。只给地址的,已有的保留原来的节点名。地址没变的保留上次取到的结果;新填的保存后马上取一次,取不到也照样保存。`node_name` 的写法:空 = 用对方的名字;固定名字时多个节点依次是「名字」「名字 2」「名字 3」;`{name}` 代表原来的名字,`{n}` 代表序号(从 1 起),如 `美国 {n}`、`专线-{name}`。改名马上生效,不用重新取 |
| `upstream_mode` | `merge`(默认):外部订阅的节点和自己线路的一起给;`replace`:只给外部订阅的节点 |
| `upstream_userinfo` | `true`:订阅里的流量和到期(`subscription-userinfo`)和自助页上显示的用外部订阅给的;停用仍按这里的额度和到期 |
| `lines` | 线路列表 |

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/customers` | 全部客户 |
| POST | `/customers` | 新建。请求体:`name`(必填)、`remark`、`quota_bytes`、`expire_at`、`reset_day`、`limit_devices`、`monthly_fee`、`traffic_ratio`、`sub_template`、`sub_links`、`upstreams`、`upstream_mode`、`upstream_userinfo` |
| PATCH | `/customers/:id` | 修改,只传要改的字段。改了额度 / 到期会立刻停用或恢复他的客户端 |
| POST | `/customers/:id/renew` | 续期。请求体:`days`(1-3650),`reset_usage`(可选,`true` 时顺带把流量清零)。在现在的到期日上加天数,已到期或没设到期日的从现在起算 |
| POST | `/customers/:id/reset-usage` | 把已用流量清零(结转的一起清) |
| POST | `/customers/:id/adjust-usage` | 调整本期已用。请求体:`up`、`down`(字节,整数,负数 = 减,至少一个不为 0)。按实际流量加减(倍率另乘),记进结转,不改面板上的计数;调完不能小于 0。之后马上停用或恢复他的客户端。迁移时搬旧系统的用量、纠错时用 |
| POST | `/customers/:id/sub-token` | 重置订阅链接,旧链接立即失效 |
| POST | `/customers/:id/upstreams/refresh` | 外部订阅马上重新取一遍,返回客户(看 `upstreams`) |
| GET | `/customers/:id/devices` | 拉过订阅的设备(`id`、`ua`、`ip`、`first_at`、`last_at`) |
| DELETE | `/customers/:id/devices/:deviceId` | 移除一台设备,让出名额 |
| DELETE | `/customers/:id` | 删除客户,连同他在各面板上的客户端 |

删线路(包括在面板卡片上删客户端、强制删面板)时,线路本期用掉的流量结转到客户身上,客户的已用不会变少。同步时面板上的计数比上次小(在面板上清零过、删了重建同名客户端、面板重装),旧计数也会结转;要清零请用 `reset-usage`。

### 外部订阅怎么取

- 客户拉订阅(或打开自助页)时去取,60 秒内取过的直接用上次的结果。请求带 `User-Agent: v2rayN/7.10.5` 和 `X-Xui-Hub-Upstream: 1`,最多等 10 秒、读 5 MB。
- 那边回的内容可以是:
  - 节点链接,每行一个(明文或整体 base64);
  - Clash / Mihomo 配置(取 `proxies`);
  - sing-box 配置(取 `outbounds`)。
- 认得的协议:vless、vmess、trojan、ss、hysteria2、tuic、anytls,参数(REALITY、flow、指纹、传输、hy2 混淆等)都带上。其他协议跳过,计入 `skipped`。
- 只取那边的节点:Clash / sing-box 配置里的分组、规则、DNS 等一概不用,客户拿到的配置是本系统的(Clash 用客户的订阅模板,sing-box 用本系统生成的配置)。
- 节点链接原样进订阅(设了 `node_name` 的只改名字),和自己线路的节点走同一套输出,每种客户端格式都有。sing-box / Quantumult X / Loon 写不出的协议或传输会跳过,和自己线路的规则一样。
- 取不到(连不上、非 2xx、内容里没有节点)时用上次取到的;一次都没取到过的算作取不到的来源。全部来源都取不到时订阅回 502,客户端保留原来的配置。
- 收到带 `X-Xui-Hub-Upstream` 头的订阅请求只给自己线路的节点,不再往外取。两边 xui-hub 互相配成外部订阅时不会绕圈。

## 线路

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/customers/:id/lines` | 开线路,见下 |
| GET | `/customers/:id/lines/:lineId/links` | 这条线路的分享链接 |
| PUT | `/customers/:id/lines/:lineId/rules` | 设置出口规则(整组替换,空数组 = 去掉),见下。写到面板的 Xray 路由并重启 Xray,这块面板上的客户端会断几秒 |
| PATCH | `/customers/:id/lines/:lineId` | 改自定义节点名。请求体:`node_name`(最多 64 个字符,空字符串 = 用面板生成的名字)。只改这里,面板上不动 |
| DELETE | `/customers/:id/lines/:lineId` | 删线路(面板上的客户端一起删);面板连不上时加 `?force=1` 只删记录 |

开直连线路(在 1 号面板上自动选一个 vless 入站,没有就新建):

```json
{ "kind": "direct", "panel_id": 1, "inbound": { "protocol": "vless" } }
```

`inbound` 也可以写 `{ "id": 3 }` 指定已有入站;`protocol` 可选 `vless` 或 `hy2`。

走 SOCKS 出口(客户端连 1 号面板,流量从 SOCKS 页登记的 1 号代理出去;只改 1 号面板):

```json
{ "kind": "relay", "panel_id": 1, "inbound": { "protocol": "vless" }, "exit": { "kind": "socks", "socks_id": 1 } }
```

`kind` 可省略:给了 `exit` 就是走 SOCKS,没给就是直出。要从另一台机器出,先在那台机器上建 socks / mixed 入站并登记到 SOCKS 页。旧版本的 `"exit": { "kind": "panel", … }` 不再支持,会返回 400。

开线路时也可以带 `"node_name": "香港 01"`:客户拉订阅时看到的节点名,不给就用面板生成的。线路对象里的 `node_name` 就是它(空 = 没自定义),订阅、分享链接里都用这个名字。

开线路时还可以带 `rules`(出口规则,格式见下):和出口路由在同一次改动里写到面板,Xray 只重启一次。后台的「批量开线路」照抄客户现有线路时就是这么开的。

**出口规则**:请求体 `{ "rules": [...] }`,按顺序匹配,先命中的生效;没命中的流量走线路原来的出口。每条:

- `domain`:域名数组(`example.com`、`geosite:netflix`,或 `domain:` / `full:` / `keyword:` / `regexp:` 开头);
- `ip`:IP、网段或 `geoip:国家代码`;
- `port`:如 `443`、`1000-2000`、`80,443`;
- `network`:`tcp` / `udp` / `tcp,udp`;
- 上面四项至少填一样,填了的要同时满足;
- `to`:出口,`{ "kind": "socks", "socks_id": 1 }`(SOCKS 页登记的)、`{ "kind": "direct" }`(直出)、`{ "kind": "block" }`(拦截)。

每条线路最多 20 条。写到面板上的规则带 `ruleTag`(`xui-hub:入站:客户端:序号`),xui-hub 只改带这个标记的,面板上手配的规则不动。返回线路对象,`rules` 是存下的规则,`routes` 是按新配置算出的实际出口。规则里用到的 SOCKS 改地址时规则跟着改;被规则用着的 SOCKS 删不了。

线路对象里的 `routes` 是面板上实际的出口,每分钟同步时读面板的 Xray 路由规则算出来(只读,不改面板),`routes_at` 是读取时间;还没读到时为 `null`。按规则顺序,每项:

- `when`:条件,如 `{ "domain": ["geosite:netflix"] }`,键有 `domain` / `ip` / `port` / `sourcePort` / `source` / `protocol` / `attrs` / `network`;
- `to`:去向,`kind` 是 `direct`(直出)/ `block`(拦截)/ `socks`(SOCKS 页登记过的,带 `socks_id`)/ `proxy`(面板上别的出站)/ `balancer`(负载均衡)/ `unknown`(规则指向的出站面板上没有),另有 `tag`(出站名)和 `address`(出站连的地址);
- `fallback`:`true` 表示这是其余流量的去向(最后一项)。

只列点名了这个客户端的规则和最后的兜底;不点名客户端、带条件的全局规则(如屏蔽 bittorrent)对谁都一样,不列。

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
| GET | `/system/version` | xui-hub 自己的版本:`current`、`latest`(GitHub 上最新的发布版本,缓存 6 小时,`?refresh=1` 重查)、`update_available`、`method`(`auto` 能在后台里直接更新 / `docker` / `manual`) |
| GET | `/traffic` | 流量统计。查询参数:`by`(`customer` 按客户,默认;`panel` 按面板),`days`(最近几天,含今天,默认 30,最多 365),`id`(可选:展开这位客户 / 这块面板名下各个客户端;按客户时 `0` 是没归入客户的客户端),`exclude`(可选:逗号分隔的面板 id,这些面板上的流量不算,按客户时就是客户在这些面板上的线路不算;只是统计时跳过,记录不动)。返回 `days`(日期)、`total`(每天的上行 / 下行)、`rows`(每行的 `up`、`down` 和每天的合计 `daily`,按用量从大到小) |

面板和 SOCKS 都带 `monthly_cost`(月成本,`null` = 没填)和 `expire_at`(到期时间,毫秒,`0` = 没填),只用来记账和提醒续费,在后台的面板页 / SOCKS 页填写。

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
