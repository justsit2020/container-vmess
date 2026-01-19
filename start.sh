#!/usr/bin/env bash
set -euo pipefail
umask 077

########################################
# 只需要改这里：端口（必须是面板分配给你的端口，并且要支持 UDP）
########################################
PORT=7681

########################################
# 固定 SNI（按你的要求）
########################################
SNI_HOST="www.bing.com"

BASE_DIR="/home/container/.hy2"
mkdir -p "$BASE_DIR"

BIN="$BASE_DIR/hysteria"
CONF="$BASE_DIR/config.yaml"
STATE="$BASE_DIR/state.env"
CERT="$BASE_DIR/cert.pem"
KEY="$BASE_DIR/key.pem"
NODEFILE="$BASE_DIR/node.txt"
LOG="$BASE_DIR/hysteria.log"

# 让 stdout/stderr 同时写入控制台与日志文件
touch "$LOG"
exec > >(tee -a "$LOG") 2>&1

echo "[init] base_dir=$BASE_DIR port=$PORT sni=$SNI_HOST"

########################################
# 防并发：锁文件 + PID；支持清理 stale lock（避免残留导致直接退出）
########################################
LOCKFILE="$BASE_DIR/runner.lock"
if [[ -f "$LOCKFILE" ]]; then
  LOCKPID="$(cat "$LOCKFILE" 2>/dev/null || true)"
  if [[ -n "${LOCKPID:-}" ]] && kill -0 "$LOCKPID" 2>/dev/null; then
    echo "[lock] another runner is active (pid=$LOCKPID). keep-alive wait..."
    while kill -0 "$LOCKPID" 2>/dev/null; do sleep 30; done
    echo "[lock] previous runner exited; continue..."
  else
    echo "[lock] stale lock found; removing."
    rm -f "$LOCKFILE"
  fi
fi
echo "$$" > "$LOCKFILE"
trap 'rm -f "$LOCKFILE" 2>/dev/null || true' EXIT

########################################
# 随机生成认证信息（首次生成后固定不变）
########################################
rand_hex() { od -An -N "$1" -tx1 /dev/urandom | tr -d ' \n'; }

if [[ ! -f "$STATE" ]]; then
  AUTH_PASS="$(rand_hex 18)"   # 36 hex
  NODE_NAME="hy2-$(rand_hex 3)"
  cat > "$STATE" <<EOF
AUTH_PASS='$AUTH_PASS'
NODE_NAME='$NODE_NAME'
EOF
fi
# shellcheck disable=SC1090
source "$STATE"

########################################
# 下载 hysteria 二进制（缺失时）
########################################
ARCH="$(uname -m 2>/dev/null || echo unknown)"
case "$ARCH" in
  x86_64|amd64)
    if grep -qi ' avx ' /proc/cpuinfo 2>/dev/null; then ASSET="hysteria-linux-amd64-avx"; else ASSET="hysteria-linux-amd64"; fi
    ;;
  aarch64|arm64) ASSET="hysteria-linux-arm64" ;;
  armv7l|armv7*) ASSET="hysteria-linux-arm" ;;
  i386|i686)     ASSET="hysteria-linux-386" ;;
  riscv64)       ASSET="hysteria-linux-riscv64" ;;
  s390x)         ASSET="hysteria-linux-s390x" ;;
  mipsle)        ASSET="hysteria-linux-mipsle" ;;
  *) echo "[fatal] unsupported arch: $ARCH"; tail -f /dev/null ;;
esac

if [[ ! -x "$BIN" ]]; then
  URL="https://download.hysteria.network/app/latest/$ASSET"
  echo "[dl] $URL"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$URL" -o "$BIN"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$BIN" "$URL"
  else
    echo "[fatal] need curl or wget."
    tail -f /dev/null
  fi
  chmod 700 "$BIN"
fi

########################################
# 生成/校验证书：必须包含 SAN=DNS:www.bing.com 才能用 sniGuard: strict
#（维护者确认：strict 依赖 SAN，CN 不够）:contentReference[oaicite:5]{index=5}
########################################
need_cert=0
if [[ ! -s "$CERT" || ! -s "$KEY" ]]; then
  need_cert=1
else
  if ! openssl x509 -in "$CERT" -noout -text 2>/dev/null | grep -q "DNS:${SNI_HOST}"; then
    echo "[tls] cert SAN does not include DNS:${SNI_HOST}; regenerating."
    need_cert=1
  fi
fi

if [[ "$need_cert" -eq 1 ]]; then
  if ! command -v openssl >/dev/null 2>&1; then
    echo "[fatal] openssl not found; cannot generate cert."
    tail -f /dev/null
  fi

  echo "[tls] generating self-signed cert with SAN=DNS:${SNI_HOST}"
  # 优先使用 -addext（openssl 1.1.1+），失败则回退到 config 文件
  if ! openssl req -x509 -newkey rsa:2048 -nodes \
      -keyout "$KEY" -out "$CERT" -days 3650 \
      -subj "/CN=${SNI_HOST}" \
      -addext "subjectAltName=DNS:${SNI_HOST}" >/dev/null 2>&1; then
    CNF="$BASE_DIR/openssl_san.cnf"
    cat > "$CNF" <<EOF
[req]
distinguished_name=req_dn
x509_extensions=v3_req
prompt=no
[req_dn]
CN=${SNI_HOST}
[v3_req]
subjectAltName=DNS:${SNI_HOST}
EOF
    openssl req -x509 -newkey rsa:2048 -nodes \
      -keyout "$KEY" -out "$CERT" -days 3650 -config "$CNF" >/dev/null 2>&1 || {
        echo "[fatal] failed to generate cert."
        tail -f /dev/null
      }
  fi
fi

# pinSHA256（用于 insecure=1 场景的指纹校验；官方强烈建议）:contentReference[oaicite:6]{index=6}
PIN_RAW="$(openssl x509 -noout -fingerprint -sha256 -in "$CERT" 2>/dev/null | sed 's/^.*=//')"
PIN_ESC="$(printf "%s" "$PIN_RAW" | sed 's/:/%3A/g')"

########################################
# 写配置：开启 sniGuard strict（前提是 SAN 正确）
########################################
cat > "$CONF" <<EOF
listen: :$PORT

tls:
  cert: $CERT
  key: $KEY
  sniGuard: strict

auth:
  type: password
  password: $AUTH_PASS
EOF

########################################
# 输出节点链接（hy2/hysteria2 URI：sni/insecure/pinSHA256 参数定义见官方）:contentReference[oaicite:7]{index=7}
########################################
HOST="${NODE_HOST:-}"
if [[ -z "$HOST" ]]; then
  if command -v curl >/dev/null 2>&1; then
    HOST="$(curl -4 -fsSL https://api.ipify.org 2>/dev/null || true)"
  elif command -v wget >/dev/null 2>&1; then
    HOST="$(wget -qO- https://api.ipify.org 2>/dev/null || true)"
  fi
fi
HOST="${HOST:-your_host}"

URI_PINNED="hy2://${AUTH_PASS}@${HOST}:${PORT}/?insecure=1&pinSHA256=${PIN_ESC}&sni=${SNI_HOST}#${NODE_NAME}"
URI_BASIC="hy2://${AUTH_PASS}@${HOST}:${PORT}/?insecure=1&sni=${SNI_HOST}#${NODE_NAME}"

cat > "$NODEFILE" <<EOF
Pinned (recommended): $URI_PINNED
Basic:              $URI_BASIC

Notes:
- sni/insecure/pinSHA256 are URI parameters defined by Hysteria 2 URI Scheme.
EOF

echo "[node] saved: $NODEFILE"
echo "[node] pinned: $URI_PINNED"
echo "[node] basic : $URI_BASIC"

########################################
# 守护运行：避免 hysteria 退出导致面板判定 offline
# 退出时带退避，防止疯狂重启耗资源
########################################
child_pid=""
_term() {
  echo "[signal] stopping..."
  if [[ -n "${child_pid:-}" ]] && kill -0 "$child_pid" 2>/dev/null; then
    kill -TERM "$child_pid" 2>/dev/null || true
    wait "$child_pid" 2>/dev/null || true
  fi
  exit 0
}
trap _term INT TERM

backoff=2
while true; do
  echo "[run] starting hysteria server..."
  set +e
  "$BIN" server -c "$CONF" &
  child_pid=$!
  wait "$child_pid"
  rc=$?
  set -e

  echo "[run] hysteria exited (rc=$rc). backoff=${backoff}s"
  sleep "$backoff"
  if [[ "$backoff" -lt 30 ]]; then backoff=$((backoff * 2)); fi
done
