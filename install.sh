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
  # GitHub API 偶尔限流,失败就跟随 releases/latest 的跳转
  curl -fsSL --max-time 15 "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null | grep -m1 -oE '"tag_name": *"[^"]+"' | cut -d'"' -f4 ||
    curl -fsSLI -o /dev/null -w '%{url_effective}' --max-time 15 "https://github.com/$REPO/releases/latest" | sed 's|.*/tag/||'
}

rand() { head -c 256 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | cut -c1-"${1:-16}"; }
env_get() { grep -E "^$1=" "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2-; }
env_set() {
  { grep -vE "^$1=" "$ENV_FILE" 2>/dev/null || true; printf '%s=%s\n' "$1" "$2"; } >"$ENV_FILE.tmp"
  mv "$ENV_FILE.tmp" "$ENV_FILE"
}

public_ip() {
  local u ip
  for u in https://api4.ipify.org https://ipv4.icanhazip.com https://4.ident.me; do
    ip="$(curl -4fsS --max-time 3 "$u" 2>/dev/null | tr -d '[:space:]')"
    if [[ "$ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then echo "$ip"; return; fi
  done
  hostname -I 2>/dev/null | awk '{print $1}'
}

open_firewall() {
  local p="$1"
  if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q '^Status: active'; then
    ufw allow "$p"/tcp >/dev/null && say "ufw 已放行 $p/tcp"
  elif command -v firewall-cmd >/dev/null && firewall-cmd --state >/dev/null 2>&1; then
    firewall-cmd -q --permanent --add-port="$p"/tcp && firewall-cmd -q --reload && say "firewalld 已放行 $p/tcp"
  fi
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
  say "下载 $name(约 47 MB)"
  curl -fsSL --retry 5 --retry-delay 3 --connect-timeout 15 -o "$tmp/$name" "$base/$name" || die "下载失败:$base/$name(检查版本是否存在、服务器能否访问 GitHub)"
  curl -fsL --retry 3 -o "$tmp/$name.sha256" "$base/$name.sha256" || die "下载校验文件失败"
  (cd "$tmp" && sha256sum -c "$name.sha256" >/dev/null) || die "sha256 校验不通过,下载的包不完整或被改动"
  tar -xzf "$tmp/$name" -C "$tmp"
  [ -x "$tmp/xui-hub/bin/node" ] && [ -f "$tmp/xui-hub/server/dist/index.js" ] || die "包里缺文件"

  # 已在运行就先停,换掉整个程序目录(数据在 /etc/xui-hub,不动)
  systemctl stop "$SERVICE" 2>/dev/null || true
  rm -rf "$DIR.new" "$DIR.old"
  mv "$tmp/xui-hub" "$DIR.new"
  [ -d "$DIR" ] && mv "$DIR" "$DIR.old"
  mv "$DIR.new" "$DIR"
  rm -rf "$DIR.old" "$tmp"
  chown -R root:root "$DIR"
  chmod -R a+rX "$DIR"

  install -m 755 "$DIR/xui-hub.sh" /usr/bin/xui-hub
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
      [ -n "$pw" ] || { read -r -s -p "后台密码(直接回车随机生成):" pw; echo; }
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
  chmod 700 "$ETC"
  chown root:"$RUN_USER" "$ENV_FILE"
  chmod 640 "$ENV_FILE"

  install -m 644 "$DIR/xui-hub.service" /etc/systemd/system/$SERVICE.service
  systemctl daemon-reload
  systemctl enable -q "$SERVICE"
  systemctl restart "$SERVICE"

  local port i
  port="$(env_get HOST_PORT)"; port="${port:-8788}"
  for i in $(seq 1 30); do
    curl -fsS -o /dev/null "http://127.0.0.1:$port/api/session" 2>/dev/null && break
    sleep 1
  done
  if ! curl -fsS -o /dev/null "http://127.0.0.1:$port/api/session" 2>/dev/null; then
    journalctl -u "$SERVICE" -n 30 --no-pager || true
    die "服务没有在 30 秒内就绪,看上面的日志(xui-hub log)"
  fi
  open_firewall "$port"

  echo
  echo -e "${green}xui-hub $tag 安装完成,正在运行${plain}"
  echo -e "  后台地址:${green}http://$(public_ip):$port${plain}"
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
│  ${green}xui-hub uninstall${plain}  卸载                      │
└──────────────────────────────────────────────┘"
}

install_base
install_xui_hub "${1:-}"
