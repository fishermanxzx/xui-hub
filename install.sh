#!/usr/bin/env bash
# xui-hub 一键安装 / 更新(root 执行):
#   bash <(curl -fsSL https://raw.githubusercontent.com/fishermanxzx/xui-hub/main/install.sh)            # 最新版
#   bash <(curl -fsSL https://raw.githubusercontent.com/fishermanxzx/xui-hub/main/install.sh) v0.1.0     # 指定版本
# 从 GitHub Release 下载按架构打好的包(自带 Node 运行时,不用装 Node / npm),解压到 /usr/local/xui-hub,
# 数据和 .env 在 /etc/xui-hub,systemd 托管,管理命令 /usr/bin/xui-hub。
# 非交互(curl | bash、cloud-init)时不提问:密码取 XUIHUB_PASSWORD,没有就随机生成;端口取 XUIHUB_PORT,默认 8788。
set -euo pipefail

REPO="${XUIHUB_REPO:-fishermanxzx/xui-hub}"
DIR=/usr/local/xui-hub
ETC=/etc/xui-hub
ENV_FILE="$ETC/.env"
SERVICE=xui-hub
RUN_USER=xuihub

red='\033[0;31m'; green='\033[0;32m'; yellow='\033[0;33m'; plain='\033[0m'
say() { echo -e "${green}==>${plain} $*"; }
warn() { echo -e "${yellow}$*${plain}"; }
die() { echo -e "${red}错误:${plain} $*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "请用 root 执行(sudo -i 后再跑)"
command -v systemctl >/dev/null || die "需要 systemd"

# 非交互:显式 XUIHUB_NONINTERACTIVE=1,或 stdin 不是终端(curl | bash)
if [ "${XUIHUB_NONINTERACTIVE:-0}" = 1 ] || [ ! -t 0 ]; then NONINTERACTIVE=1; else NONINTERACTIVE=0; fi
case "${XUIHUB_PASSWORD:-}" in *\'*) die "XUIHUB_PASSWORD 里不能有单引号" ;; esac

# 发行版
if [ -f /etc/os-release ]; then . /etc/os-release; release="${ID:-unknown}"; else release=unknown; fi

arch() {
  case "$(uname -m)" in
    x86_64 | x64 | amd64) echo amd64 ;;
    aarch64 | arm64 | armv8*) echo arm64 ;;
    *) die "不支持的 CPU 架构:$(uname -m)(只有 amd64 / arm64)" ;;
  esac
}
ARCH="$(arch)"
say "系统 $release,架构 $ARCH"

install_base() {
  say "安装基础依赖"
  case "$release" in
    ubuntu | debian | armbian | linuxmint | pop) apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl tar ca-certificates >/dev/null ;;
    fedora | rhel | almalinux | rocky | ol | amzn) dnf install -y -q curl tar ca-certificates >/dev/null ;;
    centos) (dnf install -y -q curl tar ca-certificates || yum install -y -q curl tar ca-certificates) >/dev/null ;;
    arch | manjaro) pacman -Sy --noconfirm --needed curl tar ca-certificates >/dev/null ;;
    opensuse*) zypper -q install -y curl tar ca-certificates >/dev/null ;;
    *) warn "没认出发行版 $release,假定已有 curl / tar" ;;
  esac
}

latest_tag() {
  # GitHub API 偶尔限流,拿不到就跟随 releases/latest 的跳转。管道里不能用 head / grep -m1:上游会被 SIGPIPE 打断,
  # pipefail 下整条算失败,之前因此把两种结果都输出了(得到两行版本号)
  local tag
  tag="$(curl -fsSL --max-time 15 "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null | grep -oE '"tag_name": *"[^"]+"' | sed -n '1s/.*"\([^"]*\)"$/\1/p')" || true
  [ -n "$tag" ] || tag="$(curl -fsSLI -o /dev/null -w '%{url_effective}' --max-time 15 "https://github.com/$REPO/releases/latest" | sed 's|.*/tag/||')"
  printf '%s' "$tag"
}

rand() { head -c 256 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | cut -c1-"${1:-16}"; }
# .env 里的值:带特殊字符的用单引号包起来(systemd 的 EnvironmentFile 和 docker 的 env_file 都把单引号里的内容原样读);读的时候去掉引号
env_quote() { case "$1" in *[!A-Za-z0-9_./:@%+=,-]*) printf "'%s'" "$1" ;; *) printf '%s' "$1" ;; esac; }
env_get() {
  local v
  v="$(grep -E "^$1=" "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2-)" || true
  case "$v" in \'*\') v="${v#\'}"; v="${v%\'}" ;; \"*\") v="${v#\"}"; v="${v%\"}" ;; esac
  printf '%s\n' "$v"
}
# 单引号包不住单引号自己,密码里不能有
pw_ok() { case "$1" in *\'*) return 1 ;; esac; }
env_set() {
  { grep -vE "^$1=" "$ENV_FILE" 2>/dev/null || true; printf '%s=%s\n' "$1" "$(env_quote "$2")"; } >"$ENV_FILE.tmp"
  mv "$ENV_FILE.tmp" "$ENV_FILE"
}

# 放行失败只提醒、不算安装失败:这时服务已经在跑了,脚本要是在这里退出,后面的后台地址和随机密码就没人看到
open_firewall() {
  local p="$1"
  # 管道里不用 grep -q:它匹配到就退出,上游被 SIGPIPE 打断,pipefail 下整条算失败(明明开着防火墙却判成没开)
  if command -v ufw >/dev/null && ufw status 2>/dev/null | grep '^Status: active' >/dev/null; then
    if ufw allow "$p"/tcp >/dev/null; then say "ufw 已放行 $p/tcp"; else warn "ufw 放行 $p/tcp 失败,自己放行一下:ufw allow $p/tcp"; fi
  elif command -v firewall-cmd >/dev/null && firewall-cmd --state >/dev/null 2>&1; then
    if firewall-cmd -q --permanent --add-port="$p"/tcp && firewall-cmd -q --reload; then say "firewalld 已放行 $p/tcp"; else warn "firewalld 放行 $p/tcp 失败,自己放行一下:firewall-cmd --permanent --add-port=$p/tcp && firewall-cmd --reload"; fi
  fi
  return 0
}

# 把 $DIR 里的管理脚本和服务单元装进系统,并(重)启动服务。装新版本、退回旧版本都走这里
activate() {
  chown -R root:root "$DIR"
  chmod -R a+rX "$DIR"
  install -m 755 "$DIR/xui-hub.sh" /usr/bin/xui-hub
  # subconverter 以服务用户运行并在自己目录写缓存
  [ -d "$DIR/subconverter" ] && chown -R "$RUN_USER:$RUN_USER" "$DIR/subconverter"
  install -m 644 "$DIR/xui-hub.service" /etc/systemd/system/$SERVICE.service
  if [ -f "$DIR/xui-hub-subconverter.service" ]; then
    install -m 644 "$DIR/xui-hub-subconverter.service" /etc/systemd/system/$SERVICE-subconverter.service
    systemctl daemon-reload
    systemctl enable -q "$SERVICE-subconverter"
    systemctl restart "$SERVICE-subconverter"
  fi
  # 后台里点「更新」用的:xui-hub 放下请求文件,这个 path 单元看到后以 root 跑 xui-hub update(0.13 及更早的包里没有)
  if [ -f "$DIR/xui-hub-update.path" ] && [ -f "$DIR/xui-hub-update.service" ]; then
    install -m 644 "$DIR/xui-hub-update.path" /etc/systemd/system/$SERVICE-update.path
    install -m 644 "$DIR/xui-hub-update.service" /etc/systemd/system/$SERVICE-update.service
    systemctl daemon-reload
    systemctl enable -q --now "$SERVICE-update.path" || true
  fi
  # 后台端口在 1024 以下时,给服务加上绑低端口的能力(一个 drop-in)。怎么加只在管理脚本里有一份;
  # 0.10.7 及更早的版本没有这个子命令,忽略即可
  /usr/bin/xui-hub sync-unit >/dev/null 2>&1 || true
  systemctl daemon-reload
  systemctl enable -q "$SERVICE"
  # 之前要是反复崩溃用完了启动次数限额,不清掉的话这次重启会被 systemd 拒绝
  systemctl reset-failed "$SERVICE" 2>/dev/null || true
  systemctl restart "$SERVICE"
}

# 等服务应答,最多 30 秒
wait_ready() {
  local i
  for i in $(seq 1 30); do
    curl -fsSk -o /dev/null --max-time 3 "$1" 2>/dev/null && return 0
    sleep 1
  done
  return 1
}

install_xui_hub() {
  local tag="${1:-}"
  if [ -z "$tag" ]; then
    tag="$(latest_tag)"
    [ -n "$tag" ] || die "取不到最新版本号,可能是 GitHub API 限流,稍后再试,或指定版本:install.sh v0.1.0"
  fi
  say "安装 xui-hub $tag"
  local name="xui-hub-linux-$ARCH.tar.gz" base="https://github.com/$REPO/releases/download/$tag" tmp
  tmp="$(mktemp -d)"
  say "下载 $name(几十 MB,网慢的话要等一会儿)"
  curl -fsSL --retry 5 --retry-delay 3 --connect-timeout 15 -o "$tmp/$name" "$base/$name" || die "下载失败:$base/$name(检查版本是否存在、服务器能否访问 GitHub)"
  curl -fsL --retry 3 -o "$tmp/$name.sha256" "$base/$name.sha256" || die "下载校验文件失败"
  (cd "$tmp" && sha256sum -c "$name.sha256" >/dev/null) || die "sha256 校验不通过,下载的包不完整或被改动"
  tar -xzf "$tmp/$name" -C "$tmp"
  [ -x "$tmp/xui-hub/bin/node" ] && [ -f "$tmp/xui-hub/server/dist/index.js" ] || die "包里缺文件"

  # 已在运行就先停,换掉整个程序目录(数据在 /etc/xui-hub,不动)。
  # 原来的程序目录先留在 $DIR.old:新版本起不来的话还能退回去,确认就绪了再删
  systemctl stop "$SERVICE" 2>/dev/null || true
  rm -rf "$DIR.new" "$DIR.old"
  mv "$tmp/xui-hub" "$DIR.new"
  [ -d "$DIR" ] && mv "$DIR" "$DIR.old"
  mv "$DIR.new" "$DIR"
  rm -rf "$tmp"

  id "$RUN_USER" >/dev/null 2>&1 || useradd --system --home-dir "$DIR" --shell /usr/sbin/nologin "$RUN_USER" 2>/dev/null || useradd --system --home-dir "$DIR" --shell /sbin/nologin "$RUN_USER"
  mkdir -p "$ETC"

  # 首次安装(或 .env 里还没有密码):写 .env,密码 / 端口来自环境变量或提问,否则随机 / 默认
  NEW_PASSWORD=""
  [ -f "$ENV_FILE" ] || cp "$DIR/.env.example" "$ENV_FILE"
  local cur_pw
  cur_pw="$(env_get ADMIN_PASSWORD)"
  if [ -z "$cur_pw" ] || [ "$cur_pw" = change-me ]; then
    local pw="${XUIHUB_PASSWORD:-}" port="${XUIHUB_PORT:-$(env_get HOST_PORT)}"
    if [ "$NONINTERACTIVE" = 0 ]; then
      if [ -z "$pw" ]; then
        read -r -s -p "后台密码(直接回车随机生成):" pw; echo
        until pw_ok "$pw"; do read -r -s -p "密码里不能有单引号,换一个:" pw; echo; done
      fi
      [ -n "$port" ] || read -r -p "后台端口 [8788]:" port
    fi
    [ -n "$pw" ] || { pw="$(rand 16)"; NEW_PASSWORD="$pw"; }
    port="${port:-8788}"
    [[ "$port" =~ ^[0-9]+$ ]] && [ "$port" -ge 1 ] && [ "$port" -le 65535 ] || die "端口不合法:$port"
    env_set ADMIN_PASSWORD "$pw"
    env_set HOST_PORT "$port"
    [ -n "$NEW_PASSWORD" ] || say "后台密码已按你给的写入 $ENV_FILE"
  fi
  # 数据目录归服务用户(数据库由它写);.env 归 root,服务用户只读
  chown "$RUN_USER:$RUN_USER" "$ETC"
  # 卸载时保留了数据、现在重装的:服务用户是新建的,编号可能和原来不一样,数据库和证书的属主要跟着改,不然服务读不了
  for f in "$ETC"/hub.db "$ETC"/hub.db-wal "$ETC"/hub.db-shm; do [ -e "$f" ] && chown "$RUN_USER:$RUN_USER" "$f"; done
  [ -d "$ETC/cert" ] && chgrp -R "$RUN_USER" "$ETC/cert"
  chmod 700 "$ETC"
  chown root:"$RUN_USER" "$ENV_FILE"
  chmod 640 "$ENV_FILE"

  activate

  local port scheme=http listen probe url
  port="$(env_get HOST_PORT)"; port="${port:-8788}"
  [ -n "$(env_get TLS_CERT_FILE)" ] && scheme=https
  # 探活连服务实际监听的地址:LISTEN_ADDR 写了具体地址(内网 / 隧道网卡的 IP)时,127.0.0.1 上没人听
  listen="$(env_get LISTEN_ADDR)"
  case "$listen" in "" | 0.0.0.0 | ::) listen=127.0.0.1 ;; *:*) listen="[$listen]" ;; esac
  probe="$scheme://$listen:$port/api/session"
  if ! wait_ready "$probe"; then
    journalctl -u "$SERVICE" -n 30 --no-pager || true
    # 是更新的话退回原来的版本,不把一个起不来的后台留给用户(数据库迁移只增不改,原来的程序接着能用)
    if [ -d "$DIR.old" ]; then
      warn "xui-hub $tag 没有在 30 秒内就绪(日志在上面),退回原来的版本"
      systemctl stop "$SERVICE" 2>/dev/null || true
      rm -rf "$DIR"
      mv "$DIR.old" "$DIR"
      # 退回是尽力而为:中间哪一步失败都接着往下做
      activate || true
      if wait_ready "$probe"; then
        die "xui-hub $tag 在这台机器上起不来,已退回原来的 $(cat "$DIR/VERSION" 2>/dev/null || echo 版本),服务已恢复运行"
      fi
      die "xui-hub $tag 起不来,退回原来的版本后也没起来:问题多半不在版本上,检查 $ENV_FILE 和日志(xui-hub log)"
    fi
    die "服务没有在 30 秒内就绪,看上面的日志(xui-hub log)"
  fi
  rm -rf "$DIR.old"
  open_firewall "$port"

  # 后台地址问刚装好的管理脚本(证书签给哪个域名、只监听哪个地址,算法只在它那里有一份)。
  # 指定装 0.10.5 及更早的版本时它还没有 address 子命令,就只给个样子
  url="$(/usr/bin/xui-hub address 2>/dev/null)" || url=""
  case "$url" in http://?* | https://?*) ;; *) url="$scheme://<服务器 IP>:$port" ;; esac

  echo
  echo -e "${green}xui-hub $tag 安装完成,正在运行${plain}"
  echo -e "  后台地址:${green}$url${plain}"
  if [ -n "$NEW_PASSWORD" ]; then
    echo -e "  后台密码:${green}$NEW_PASSWORD${plain}   (已写入 $ENV_FILE)"
  else
    echo -e "  后台密码:沿用 $ENV_FILE 里的 ADMIN_PASSWORD"
  fi
  echo -e "  云服务器记得在安全组里放行 ${port}/tcp"
  echo -e "
┌──────────────────────────────────────────────┐
│  ${green}xui-hub${plain}            管理菜单                  │
│  ${green}xui-hub status${plain}     运行状态                  │
│  ${green}xui-hub log${plain}        实时日志                  │
│  ${green}xui-hub update${plain}     更新到最新版              │
│  ${green}xui-hub password${plain}   重设后台密码              │
│  ${green}xui-hub port${plain}       改后台端口                │
│  ${green}xui-hub ssl${plain}        SSL 证书管理(HTTPS)      │
│  ${green}xui-hub uninstall${plain}  卸载                      │
└──────────────────────────────────────────────┘"
}

install_base
install_xui_hub "${1:-}"
