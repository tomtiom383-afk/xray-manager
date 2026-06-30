#!/bin/bash
set -e

APP_NAME="xray-manager"
APP_DIR="/opt/${APP_NAME}"
GITHUB_REPO="tomtiom383-afk/xray-manager"

if [ "$(id -u)" -ne 0 ]; then
  echo "请使用 root 运行: sudo bash"
  exit 1
fi

# Detect source: if piped via curl, clone from GitHub; otherwise use local copy
if [ -f "${BASH_SOURCE[0]}" ] && [ "${BASH_SOURCE[0]}" != "bash" ]; then
  SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
else
  echo "[0/4] 从 GitHub 拉取项目"
  command -v git &>/dev/null || apt-get update && apt-get install -y git
  TMP_DIR=$(mktemp -d)
  git clone --depth 1 "https://github.com/${GITHUB_REPO}.git" "${TMP_DIR}"
  SOURCE_DIR="${TMP_DIR}"
fi

if ! command -v docker &>/dev/null || { ! docker compose version &>/dev/null && ! command -v docker-compose &>/dev/null; }; then
  echo "[1/4] 安装 Docker 和 Docker Compose"
  curl -fsSL https://get.docker.com | sh
else
  echo "[1/4] Docker 已安装"
fi

echo "[2/4] 复制文件到 ${APP_DIR}"
mkdir -p "${APP_DIR}"
rsync -a --delete \
  --exclude ".venv" \
  --exclude "__pycache__" \
  --exclude ".git" \
  "${SOURCE_DIR}/" "${APP_DIR}/"

# Clean up temp clone if used
[ -n "${TMP_DIR:-}" ] && rm -rf "${TMP_DIR}"

cd "${APP_DIR}"

echo "[3/4] 构建并启动容器"
docker compose build --no-cache
docker compose up -d

echo "[4/4] 安装完成"
cat <<'EOF'

Xray Manager 已运行在 127.0.0.1:8080。
此应用仅用于生成、预览、复制和下载 Xray config.json，不会读取、写入或重载本机 Xray 服务。
请勿直接暴露公网，建议通过 Cloudflare 反向代理访问。

常用命令：
  cd /opt/xray-manager && docker compose logs -f
  cd /opt/xray-manager && docker compose restart
  cd /opt/xray-manager && docker compose down

更新：
  cd /opt/xray-manager && docker compose pull && docker compose up -d --build
EOF
