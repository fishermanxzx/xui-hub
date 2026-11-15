#!/usr/bin/env bash
# 给 Docker 部署的 xui-hub 申请 HTTPS 证书(acme.sh + Let's Encrypt),装好并自动续期。
# 在放 docker-compose.yml 的目录里用 root 执行:
#   bash <(curl -fsSL https://raw.githubusercontent.com/fishermanxzx/xui-hub/main/scripts/docker-ssl.sh)
# 不带参数进菜单,也可以直接:
#   … docker-ssl.sh domain <域名>   域名证书(HTTP-01,要 80 端口能从公网访问)
#   … docker-ssl.sh ip [IP]         IP 证书(6 天有效,自动续期)
#   … docker-ssl.sh cf <域名>       用 Cloudflare DNS 验证(含通配符,不用开 80)
#   … docker-ssl.sh off             关闭 HTTPS
# 证书放在 ./cert,挂进容器的 /cert;续期后自动重启容器。acme.sh 装在宿主机上。
set -uo pipefail

DIR="${XUIHUB_DIR:-$PWD}"
COMPOSE="$DIR/docker-compose.yml"
ENV_FILE="$DIR/.env"
CERT_DIR="$DIR/cert"
ACME="$HOME/.acme.sh/acme.sh"
# 容器里跑服务的用户(镜像里的 node)
RUN_UID=1000

red='\033[0;31m'; green='\033[0;32m'; yellow='\033[0;33m'; plain='\033[0m'
ok() { echo -e "${green}$*${plain}"; }
warn() { echo -e "${yellow}$*${plain}"; }
err() { echo -e "${red}$*${plain}" >&2; }
die() { err "$*"; exit 1; }

is_domain() { [[ "$1" =~ ^([A-Za-z0-9](-*[A-Za-z0-9])*\.)+[A-Za-z]{2,}$ ]]; }
is_ipv4() { [[ "$1" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]]; }
public_ip() { curl -4fsS --max-time 3 https://api4.ipify.org 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}'; }
port_in_use() { [ -n "$(ss -ltn 2>/dev/null | awk -v p="$1" '$4 ~ ("[:.]" p "$")')" ]; }
env_get() { { grep -E "^$1=" "$ENV_FILE" 2>/dev/null || true; } | tail -n 1 | cut -d= -f2- | sed -e "s/^'//" -e "s/'$//"; }
env_set() {
  { grep -vE "^$1=" "$ENV_FILE" 2>/dev/null || true; printf '%s=%s\n' "$1" "$2"; } >"$ENV_FILE.tmp"
  mv "$ENV_FILE.tmp" "$ENV_FILE"; chmod 600 "$ENV_FILE"
}
env_del() {
  { grep -vE "^($1)=" "$ENV_FILE" 2>/dev/null || true; } >"$ENV_FILE.tmp"
  mv "$ENV_FILE.tmp" "$ENV_FILE"; chmod 600 "$ENV_FILE"
}
port() { local p; p="$(env_get HOST_PORT)"; echo "${p:-8788}"; }
compose() { (cd "$DIR" && docker compose "$@"); }

preflight() {
  [ "$(id -u)" = 0 ] || die "请用 root 执行"
  [ -f "$COMPOSE" ] && grep -q "xui-hub" "$COMPOSE" || die "当前目录($DIR)里没有 xui-hub 的 docker-compose.yml。先 cd 到放 docker-compose.yml 的目录再执行"
  [ -f "$ENV_FILE" ] || die "$DIR 里没有 .env"
  docker compose version >/dev/null 2>&1 || die "没有 docker compose 命令"
}

install_acme() {
  [ -x "$ACME" ] && return 0
  ok "安装 acme.sh"
  # HTTP-01 验证要用 socat,自动续期要用 cron
  if command -v apt-get >/dev/null; then DEBIAN_FRONTEND=noninteractive apt-get install -y -qq socat cron openssl >/dev/null 2>&1
  elif command -v dnf >/dev/null; then dnf install -y -q socat cronie openssl >/dev/null 2>&1
  elif command -v yum >/dev/null; then yum install -y -q socat cronie openssl >/dev/null 2>&1
  elif command -v pacman >/dev/null; then pacman -Sy --noconfirm --needed socat cronie openssl >/dev/null 2>&1
  elif command -v zypper >/dev/null; then zypper -q install -y socat cron openssl >/dev/null 2>&1
  fi
  (cd "$HOME" && curl -fsSL https://get.acme.sh | sh -s >/dev/null 2>&1) || { err "acme.sh 安装失败"; return 1; }
  [ -x "$ACME" ] || { err "acme.sh 安装失败"; return 1; }
  "$ACME" --set-default-ca --server letsencrypt >/dev/null 2>&1
}

# acme.sh 的证书状态目录(申请失败时清掉,否则下次会沿用坏状态)
acme_state_rm() { local id="${1:?}"; rm -rf "${HOME:?}/.acme.sh/${id}" "${HOME:?}/.acme.sh/${id}_ecc"; }

# 跑 acme.sh --issue:先说要等多久(期间 acme.sh 没有输出,不提示会像卡死),失败时把 acme.sh 自己的报错打出来
acme_issue() {
  local hint="$1" out rc=0; shift
  echo "  $hint,期间没有输出是正常的,不要按 Ctrl+C…"
  out="$("$ACME" --issue "$@" --server letsencrypt --keylength ec-256 --force 2>&1)" || rc=$?
  case "$out" in *"Cert success"*) return 0 ;; esac
  err "acme.sh 的报错(退出码 $rc):"
  { printf '%s\n' "$out" | grep -iE "error|invalid|fail|denied|unauthorized|rate ?limit|timeout|not found|refused|detail" || printf '%s\n' "$out" | tail -n 8; } |
    tail -n 12 | sed -e "s/${CF_Token:-__no_token__}/***/g" -e 's/^\[[^]]*\] */    /' >&2
  return 1
}

cert_summary() {
  local issuer end
  issuer="$(openssl x509 -in "$1" -noout -issuer 2>/dev/null | sed 's/.*O *= *\([^,]*\).*/\1/')"
  end="$(openssl x509 -in "$1" -noout -enddate 2>/dev/null | cut -d= -f2)"
  echo "签发:${issuer:-?},到期:${end:-?}"
}

# compose 里要有把 ./cert 挂到 /cert 的那一行;旧版 compose 里它是注释掉的,帮忙打开(原文件留一份 .bak)
ensure_mount() {
  grep -qE '^[[:space:]]*-[[:space:]]*"?\./cert:/cert(:ro)?"?[[:space:]]*$' "$COMPOSE" && return 0
  if grep -qE '^[[:space:]]*#[[:space:]]*-[[:space:]]*\./cert:/cert:ro[[:space:]]*$' "$COMPOSE"; then
    cp "$COMPOSE" "$COMPOSE.bak-$(date +%Y%m%d-%H%M%S)"
    sed -i -E 's|^([[:space:]]*)#[[:space:]]*(-[[:space:]]*\./cert:/cert:ro)[[:space:]]*$|\1\2|' "$COMPOSE"
    ok "已在 docker-compose.yml 里打开证书目录的挂载(原文件留了一份 .bak)"
    return 0
  fi
  err "docker-compose.yml 里没有把 ./cert 挂进容器。在 app 的 volumes 下面加一行再执行:"
  err "      - ./cert:/cert:ro"
  return 1
}

# 把 acme.sh 里的证书装到 ./cert,续期后自动重启容器;容器里的用户要能读私钥
install_cert() {
  local id="$1"
  mkdir -p "$CERT_DIR"
  local reload="chown $RUN_UID:$RUN_UID '$CERT_DIR/fullchain.pem' '$CERT_DIR/privkey.pem'; docker restart xui-hub"
  "$ACME" --install-cert -d "$id" --ecc --fullchain-file "$CERT_DIR/fullchain.pem" --key-file "$CERT_DIR/privkey.pem" --reloadcmd "$reload" >/dev/null 2>&1 || true
  [ -s "$CERT_DIR/fullchain.pem" ] && [ -s "$CERT_DIR/privkey.pem" ] || { err "证书文件没有写出来"; return 1; }
  chown "$RUN_UID:$RUN_UID" "$CERT_DIR" "$CERT_DIR/fullchain.pem" "$CERT_DIR/privkey.pem"
  chmod 750 "$CERT_DIR"; chmod 600 "$CERT_DIR/privkey.pem"; chmod 644 "$CERT_DIR/fullchain.pem"
  "$ACME" --upgrade --auto-upgrade >/dev/null 2>&1 || true
  ok "证书已装到 $CERT_DIR($(cert_summary "$CERT_DIR/fullchain.pem")),acme.sh 会自动续期"
}

# 等容器起来:最多 40 秒
wait_up() {
  local i
  for i in $(seq 1 20); do
    sleep 2
    curl -ksf -o /dev/null --max-time 3 "$1://127.0.0.1:$(port)/api/session" && return 0
  done
  return 1
}

use_cert() {
  local host="$1"
  env_set TLS_CERT_FILE /cert/fullchain.pem
  env_set TLS_KEY_FILE /cert/privkey.pem
  compose up -d >/dev/null 2>&1 || { err "docker compose up -d 失败,手动执行看报错"; return 1; }
  if wait_up https; then
    ok "xui-hub 已切到 HTTPS:https://$host:$(port)"
    [ "$host" != "$(public_ip)" ] && echo "  确认域名 $host 已解析到本机 $(public_ip)"
  else
    err "容器没起来,看日志:docker compose logs --tail 30 app"; return 1
  fi
}

issue_domain() {
  # 先确认 compose 里证书目录挂得上,免得签完才发现用不了
  ensure_mount || return 1
  install_acme || return 1
  local domain="${1:-}"
  while ! is_domain "$domain"; do read -r -p "域名(A 记录已指向本机):" domain; done
  port_in_use 80 && { err "80 端口被占用,HTTP-01 验证要用 80;先停掉占用的服务,或改用 cf(Cloudflare DNS 验证)"; return 1; }
  ok "申请 $domain 的证书(HTTP-01,监听 80)"
  if ! acme_issue "正在验证并签发,一般不到 1 分钟" --standalone -d "$domain"; then
    err "申请失败:确认域名已解析到本机、80 端口能从公网访问"; acme_state_rm "$domain"; return 1
  fi
  install_cert "$domain" && use_cert "$domain"
}

issue_ip() {
  # 先确认 compose 里证书目录挂得上,免得签完才发现用不了
  ensure_mount || return 1
  install_acme || return 1
  local ip="${1:-}" a
  if [ -z "$ip" ]; then ip="$(public_ip)"; read -r -p "给哪个公网 IPv4 申请证书 [$ip]:" a; ip="${a:-$ip}"; fi
  is_ipv4 "$ip" || { err "IP 不合法:$ip"; return 1; }
  port_in_use 80 && { err "80 端口被占用,Let's Encrypt 要从 80 端口验证;先停掉占用的服务再试"; return 1; }
  warn "Let's Encrypt 给 IP 签的证书只有 6 天有效期,acme.sh 的 cron 会自动续,续完自动重启容器"
  ok "申请 $ip 的证书(HTTP-01,监听 80)"
  if ! acme_issue "正在验证并签发,一般不到 1 分钟" --standalone -d "$ip" --certificate-profile shortlived --days 6; then
    err "申请失败:确认 80 端口能从公网访问(安全组 / 防火墙)"; acme_state_rm "$ip"; return 1
  fi
  install_cert "$ip" && use_cert "$ip"
}

issue_cf() {
  # 先确认 compose 里证书目录挂得上,免得签完才发现用不了
  ensure_mount || return 1
  install_acme || return 1
  local domain="${1:-}" token="${CF_Token:-}"
  while ! is_domain "$domain"; do read -r -p "域名(会同时签 *.域名 通配符):" domain; done
  if [ -z "$token" ]; then read -r -s -p "Cloudflare API Token(权限 Zone:DNS:Edit):" token; echo; fi
  [ -n "$token" ] || { err "Token 不能为空"; return 1; }
  export CF_Token="$token"
  ok "申请 $domain 和 *.$domain 的证书(Cloudflare DNS 验证,不需要开 80)"
  if ! acme_issue "正在加 DNS 记录、等它生效再签发,大约要 1-3 分钟" --dns dns_cf -d "$domain" -d "*.$domain"; then
    err "申请失败:检查 Token(要「API 令牌」,权限 Zone:DNS:Edit,区域包含这个域名)以及域名是否托管在这个 Cloudflare 账号下"
    acme_state_rm "$domain"; return 1
  fi
  install_cert "$domain" && use_cert "$domain"
}

ssl_off() {
  env_del 'TLS_CERT_FILE|TLS_KEY_FILE'
  compose up -d >/dev/null 2>&1 || { err "docker compose up -d 失败,手动执行看报错"; return 1; }
  if wait_up http; then ok "已关闭 HTTPS,后台地址 http://$(public_ip):$(port)(证书和自动续期还留着)"; else err "容器没起来:docker compose logs --tail 30 app"; return 1; fi
}

menu() {
  echo -e "
  ${green}xui-hub(Docker)HTTPS 证书${plain}(acme.sh + Let's Encrypt,证书放在 $CERT_DIR)
  ${green}1.${plain} 申请域名证书(HTTP-01,需要 80 端口能从公网访问)
  ${green}2.${plain} 申请 IP 证书(6 天有效,自动续期)
  ${green}3.${plain} 用 Cloudflare DNS 申请域名证书(含通配符,不需要开 80)
  ${green}4.${plain} 关闭 HTTPS
  ${green}0.${plain} 退出"
  if [ -n "$(env_get TLS_CERT_FILE)" ]; then echo "  现在:HTTPS$([ -s "$CERT_DIR/fullchain.pem" ] && echo "($(cert_summary "$CERT_DIR/fullchain.pem"))")"; else echo "  现在:HTTP"; fi
  local c
  read -r -p "请选择 [0-4]:" c
  case "$c" in
    0) exit 0 ;;
    1) issue_domain ;;
    2) issue_ip ;;
    3) issue_cf ;;
    4) ssl_off ;;
    *) err "没有这个选项"; return 1 ;;
  esac
}

preflight
case "${1:-}" in
  "") menu ;;
  domain) issue_domain "${2:-}" ;;
  ip) issue_ip "${2:-}" ;;
  cf) issue_cf "${2:-}" ;;
  off) ssl_off ;;
  *) sed -n '2,10p' "$0" 2>/dev/null | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
