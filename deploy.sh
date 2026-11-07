#!/bin/sh
# 服务器上更新部署:备份数据库 → 从 GitHub 拉最新代码 → 重建并等健康检查 → Caddyfile 有变化时热重载。
# 用法(在服务器上):/opt/xui-hub/deploy.sh
set -eu
cd "$(dirname "$0")"

# 1. 备份数据库(app 没在运行时跳过);过期备份由服务自己按 BACKUP_KEEP_DAYS 清理
if ! docker compose exec -T app node server/dist/backup.js < /dev/null; then
  echo "app 未运行,跳过备份"
fi

# 2. 拉代码:只允许快进,服务器上不应有本地改动
before=$(git rev-parse HEAD)
git pull --ff-only
after=$(git rev-parse HEAD)
if [ "$before" = "$after" ]; then
  echo "代码已是最新:$(git log --oneline -1)"
else
  echo "代码更新:"
  git log --oneline "$before..$after"
fi

# 3. 重建并等健康检查
docker compose up -d --build < /dev/null
for _ in $(seq 1 40); do
  [ "$(docker inspect -f '{{.State.Health.Status}}' xui-hub)" = healthy ] && break
  sleep 3
done
status=$(docker inspect -f '{{.State.Health.Status}}' xui-hub)
echo "app:$status"
[ "$status" = healthy ] || exit 1

# 4. Caddyfile 有变化时热重载(按目录挂载,容器里已是新文件)
if ! git diff --quiet "$before" "$after" -- caddy/; then
  docker compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile < /dev/null
  echo "Caddy 已重载"
fi
