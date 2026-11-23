# MCP

xui-hub 自带一个 [MCP](https://modelcontextprotocol.io) 服务,让 Claude、Cursor 这类 AI 客户端直接管理客户和线路。

- 地址:`https://<后台地址>/mcp`(Streamable HTTP)
- 协议由官方 SDK v2(`@modelcontextprotocol/server`)处理:`2026-07-28`(无握手)和 2025 年各版(握手)都支持
- 没设后台密码(只监听本机)时不需要鉴权

## 接入方式一:OAuth

在客户端里只填 MCP 地址。客户端会自动发现授权服务器、注册自己,然后打开授权页;输入后台密码,点「允许」。

- 授权过的应用列在后台「设置 → MCP」,可以随时撤销。
- 访问令牌 1 小时有效,客户端用刷新令牌自动续;60 天没用过的授权会失效。
- 客户端在外网(如 claude.ai 的自定义连接器)时,后台地址要能从公网用 HTTPS 访问。前面有反代的,反代要把 `Host` 和 `X-Forwarded-Proto` 原样传过来。

实现的是 OAuth 2.1 授权码 + PKCE(S256),公开客户端。支持动态客户端注册(RFC 7591)和 Client ID Metadata Document;发现文档在 `/.well-known/oauth-protected-resource` 和 `/.well-known/oauth-authorization-server`。

## 接入方式二:API 令牌

在后台「设置 → 开放 API」生成一个令牌,客户端里把它配成请求头:

```
Authorization: Bearer xh_……
```

Claude Code:

```bash
claude mcp add --transport http xui-hub https://hub.example.com:8788/mcp --header "Authorization: Bearer xh_……"
```

用配置文件的客户端(Cursor、Claude Desktop 等):

```json
{
  "mcpServers": {
    "xui-hub": {
      "url": "https://hub.example.com:8788/mcp",
      "headers": { "Authorization": "Bearer xh_……" }
    }
  }
}
```

## 工具

| 工具 | 作用 |
|---|---|
| `list_customers` | 全部客户:状态、流量(计费用量和实际流量)、到期、月费、订阅链接、线路 |
| `create_customer` | 新建客户 |
| `update_customer` | 改名称、额度、到期、清零日、设备数上限、月费、订阅模板、自定义订阅链接、外部订阅 |
| `refresh_upstreams` | 外部订阅马上重新取一遍 |
| `renew_customer` | 续费若干个月或若干天,收了钱填金额记成一笔收款,可顺带清零流量 |
| `list_payments` | 续费 / 收款记录(全部或某位客户的),带合计 |
| `reset_customer_usage` | 清零已用流量 |
| `adjust_customer_usage` | 调整本期已用(直接加减计费用量 GB,不乘面板倍率;迁移旧用量、纠错) |
| `reset_subscription_link` | 重置订阅链接,旧链接失效 |
| `delete_customer` | 删除客户,连同面板上的客户端 |
| `list_devices` | 拉过订阅的设备和最近的拉取记录 |
| `remove_device` | 移除一台设备 |
| `open_line` | 开线路:直出,或经登记的 SOCKS 出去 |
| `get_line_links` | 线路的分享链接 |
| `set_line_rules` | 设置线路的出口规则(条件 → SOCKS / 直出 / 拦截),写到面板并重启 Xray |
| `rename_line` | 改线路的自定义节点名(客户拉订阅时看到的名字) |
| `change_line_exit` | 线路原地换出口(某个 SOCKS 或直出),一条、几条或某位客户的全部线路;UUID 不变,会重启面板的 Xray,执行前向你确认 |
| `delete_line` | 删线路 |
| `list_panels` | 面板列表和状态 |
| `list_panel_inbounds` | 面板上的入站和客户端 |
| `list_socks` | SOCKS 代理列表 |
| `sync_now` | 立即同步流量并执行额度 / 到期 |

MCP 改不了后台设置,碰不了备份恢复、API 令牌,也不能增删面板和 SOCKS。
