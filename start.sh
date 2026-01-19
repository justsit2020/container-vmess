#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$APP_DIR"

MAIN_FILE="${MAIN_FILE:-index.js}"

LOCK_FILE="$APP_DIR/.app.lock"
LOCK_DIR="$APP_DIR/.app.lockdir"
STAMP_FILE="$APP_DIR/.deps_installed"

echo "[start] workdir: $APP_DIR"

# -----------------------
# 0) 单例锁：防止并发/重复拉起
# -----------------------
LOCK_MODE=""

if command -v flock >/dev/null 2>&1; then
  # 使用文件描述符持锁；后续 exec 给 node 时，锁也会一直保留
  exec 9>"$LOCK_FILE"
  if ! flock -n 9; then
    echo "[start] already running (flock busy). exit."
    exit 0
  fi
  LOCK_MODE="flock"
else
  # flock 不存在则用 mkdir 原子加锁（目录存在说明已有实例）
  if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    echo "[start] already running (lockdir exists). exit."
    exit 0
  fi
  LOCK_MODE="mkdir"
  # 注意：如果用 exec，会替换掉 shell，trap 不会执行，所以 mkdir 模式下不 exec
  trap 'rm -rf "$LOCK_DIR"' EXIT INT TERM
fi

# -----------------------
# 1) 基础检查
# -----------------------
if ! command -v node >/dev/null 2>&1; then
  echo "[fatal] node not found in PATH"
  exit 1
fi

if [ ! -f "$MAIN_FILE" ]; then
  echo "[fatal] main file not found: $MAIN_FILE"
  exit 1
fi

if [ ! -f package.json ]; then
  echo "[fatal] package.json not found"
  exit 1
fi

# -----------------------
# 2) 依赖安装去重：仅在需要时安装
# -----------------------
export NODE_ENV="${NODE_ENV:-production}"

need_install=0
if [ ! -d node_modules ]; then
  need_install=1
fi

# 只要这些文件比戳记新，就重新安装
for f in package.json package-lock.json npm-shrinkwrap.json pnpm-lock.yaml yarn.lock; do
  if [ -f "$f" ] && { [ ! -f "$STAMP_FILE" ] || [ "$f" -nt "$STAMP_FILE" ]; }; then
    need_install=1
  fi
done

if [ "$need_install" -eq 1 ]; then
  echo "[start] deps changed/missing -> installing..."

  if command -v npm >/dev/null 2>&1; then
    if [ -f package-lock.json ] || [ -f npm-shrinkwrap.json ]; then
      echo "[start] npm ci --omit=dev"
      npm ci --omit=dev
    else
      echo "[start] npm install --omit=dev"
      npm install --omit=dev
    fi
  elif command -v pnpm >/dev/null 2>&1; then
    echo "[start] pnpm install --prod"
    pnpm install --prod
  elif command -v yarn >/dev/null 2>&1; then
    echo "[start] yarn install --production"
    yarn install --production --frozen-lockfile 2>/dev/null || yarn install --production
  else
    echo "[fatal] no npm/pnpm/yarn found; cannot install dependencies"
    exit 1
  fi

  touch "$STAMP_FILE"
else
  echo "[start] deps unchanged -> skip install"
fi

# -----------------------
# 3) 启动
# -----------------------
echo "[start] launching: node $MAIN_FILE"

if [ "$LOCK_MODE" = "flock" ]; then
  # flock 模式下用 exec：不会多一个 bash 常驻进程，锁会随 fd 9 一直保持
  exec node "$MAIN_FILE"
else
  # mkdir 模式下不 exec：保证脚本退出时能清理锁目录（trap 生效）
  node "$MAIN_FILE"
fi
