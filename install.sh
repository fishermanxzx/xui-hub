#!/usr/bin/env bash
# xui-hub 一键安装(Debian / Ubuntu,root 执行):
#   bash <(curl -fsSL https://raw.githubusercontent.com/fishermanxzx/xui-hub/main/install.sh)
# 做的事:装 git / curl / Node 22 → 把代码拉到 /opt/xui-hub → 交给 scripts/xui-hub setup 构建并用 systemd 托管。
# 已安装过的机器再跑一遍等于更新。不用 Docker;要用 Docker 部署看 README。
set -euo pipefail

REPO="${XUI_HUB_REPO:-https://github.com/fishermanxzx/xui-hub.git}"
DIR="${XUI_HUB_DIR:-/opt/xui-hub}"
BRANCH="${XUI_HUB_BRANCH:-main}"

say() { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m错误:\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "请用 root 执行(sudo -i 后再跑)"
command -v apt-get >/dev/null || die "只支持 Debian / Ubuntu(需要 apt-get)"
export DEBIAN_FRONTEND=noninteractive

say "安装基础依赖"
apt-get update -qq
apt-get install -y -qq curl git ca-certificates >/dev/null

node_major() { command -v node >/dev/null && node -v | sed 's/^v//' | cut -d. -f1 || echo 0; }
if [ "$(node_major)" -lt 22 ]; then
  say "安装 Node.js 22(NodeSource)"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
say "Node $(node -v),npm $(npm -v)"

if [ -d "$DIR/.git" ]; then
  say "已有安装,更新代码:$DIR"
  git -C "$DIR" fetch -q origin "$BRANCH"
  git -C "$DIR" checkout -q "$BRANCH"
  git -C "$DIR" pull -q --ff-only origin "$BRANCH"
else
  [ -e "$DIR" ] && die "$DIR 已存在但不是 git 仓库,先把它移走"
  say "拉取代码到 $DIR"
  git clone -q --branch "$BRANCH" "$REPO" "$DIR"
fi

exec bash "$DIR/scripts/xui-hub" setup
