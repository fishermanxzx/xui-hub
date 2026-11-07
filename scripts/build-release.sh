#!/usr/bin/env bash
# 打发布包:xui-hub-linux-<arch>.tar.gz(+ .sha256),里面带 Node 运行时、构建好的前后端和生产依赖,
# 服务器上解压就能跑,不用装 Node、不用 npm。GitHub Actions 在打 tag 时调用;本地也能跑(需要能访问 nodejs.org / npm / GitHub)。
# 用法:scripts/build-release.sh <amd64|arm64> <版本号,如 v0.1.0> [输出目录,默认 dist-release]
set -euo pipefail

ARCH="${1:?用法:build-release.sh <amd64|arm64> <版本> [输出目录]}"
VERSION="${2:?缺少版本号}"
OUT="$(mkdir -p "${3:-dist-release}" && cd "${3:-dist-release}" && pwd)"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

case "$ARCH" in
  amd64) NODE_ARCH=x64 ;;
  arm64) NODE_ARCH=arm64 ;;
  *) echo "不支持的架构:$ARCH(只有 amd64 / arm64)" >&2; exit 1 ;;
esac

say() { printf '\033[1;32m==>\033[0m %s\n' "$*"; }

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
PKG="$STAGE/xui-hub"
mkdir -p "$PKG/bin" "$PKG/server" "$PKG/web"

say "构建前端"
(cd "$ROOT/web" && npm ci --no-audit --no-fund --loglevel=error && npm run build --silent)
cp -R "$ROOT/web/dist" "$PKG/web/dist"

say "构建后端"
(cd "$ROOT/server" && npm ci --no-audit --no-fund --loglevel=error && npm run build --silent)
cp -R "$ROOT/server/dist" "$PKG/server/dist"
cp "$ROOT/server/package.json" "$ROOT/server/package-lock.json" "$PKG/server/"

say "安装生产依赖(linux/$NODE_ARCH 的 better-sqlite3 预编译包)"
# npm_config_platform / npm_config_arch 让 prebuild-install 下载目标平台的二进制,而不是当前机器的
(cd "$PKG/server" && npm_config_platform=linux npm_config_arch="$NODE_ARCH" npm ci --omit=dev --no-audit --no-fund --loglevel=error)
rm -f "$PKG/server/package-lock.json"
test -f "$PKG/server/node_modules/better-sqlite3/build/Release/better_sqlite3.node" || { echo "better-sqlite3 没有拿到预编译包" >&2; exit 1; }

say "下载 Node 22 运行时(linux-$NODE_ARCH)"
NODE_VERSION="$(curl -fsSL https://nodejs.org/dist/index.json | grep -oE '"version":"v22\.[0-9]+\.[0-9]+"' | head -1 | cut -d'"' -f4)"
[ -n "$NODE_VERSION" ] || { echo "取不到 Node 22 版本号" >&2; exit 1; }
curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-linux-$NODE_ARCH.tar.xz" -o "$STAGE/node.tar.xz"
tar -xJf "$STAGE/node.tar.xz" -C "$STAGE" "node-$NODE_VERSION-linux-$NODE_ARCH/bin/node"
mv "$STAGE/node-$NODE_VERSION-linux-$NODE_ARCH/bin/node" "$PKG/bin/node"
chmod 755 "$PKG/bin/node"

say "打包"
cp "$ROOT/scripts/xui-hub" "$PKG/xui-hub.sh"
cp "$ROOT/xui-hub.service" "$ROOT/.env.example" "$ROOT/LICENSE" "$PKG/"
printf '%s\n' "$VERSION" >"$PKG/VERSION"
printf 'node=%s\narch=%s\nbuilt=%s\n' "$NODE_VERSION" "$ARCH" "$(date -u +%FT%TZ)" >"$PKG/BUILD"
chmod 755 "$PKG/xui-hub.sh"
NAME="xui-hub-linux-$ARCH.tar.gz"
tar -czf "$OUT/$NAME" -C "$STAGE" xui-hub
(cd "$OUT" && { command -v sha256sum >/dev/null && sha256sum "$NAME" || shasum -a 256 "$NAME"; } >"$NAME.sha256")
say "完成:$OUT/$NAME($(du -h "$OUT/$NAME" | cut -f1))"
