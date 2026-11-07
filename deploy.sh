#!/bin/sh
# Docker 部署的更新脚本(在服务器上执行):从 GitHub 拉最新代码 → 重建并等健康检查。
# 用法:/opt/xui-hub/deploy.sh
set -eu
cd "$(dirname "$0")"

before=$(git rev-parse HEAD)
git pull --ff-only
after=$(git rev-parse HEAD)
if [ "$before" = "$after" ]; then
  echo "代码已是最新:$(git log --oneline -1)"
else
  echo "代码更新:"
  git log --oneline "$before..$after"
fi

docker compose up -d --build < /dev/null
for _ in $(seq 1 40); do
  [ "$(docker inspect -f '{{.State.Health.Status}}' xui-hub)" = healthy ] && break
  sleep 3
done
status=$(docker inspect -f '{{.State.Health.Status}}' xui-hub)
echo "app:$status"
[ "$status" = healthy ] || exit 1
