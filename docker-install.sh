#!/bin/bash
set -e

APP_NAME="xray-manager"
APP_DIR="/opt/${APP_NAME}"
SERVICE_FILE="/etc/systemd/system/${APP_NAME}.service"
SOURCE_DIR="$(cd "$(dirname "$0")" && pwd)"

if [ "$(id -u)" -ne 0 ]; then
  echo "请使用 root 运行 install.sh"
  exit 1
fi

if ! command -v docker &>/dev/null || { ! docker compose version &>/dev/null && ! command -v docker-compose &>/dev/null; }; then
  echo "[1/4] 安装 Docker 和 Docker Compose"
  apt-get update
  apt-get install -y ca-certificates curl gnupg
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list
  apt-get update
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
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

cd "${APP_DIR}"

echo "[3/4] 构建并启动容器"
docker compose build --no-cache
docker compose up -d

echo "[4/4] 安装完成"
cat <<'EOF'

Xray Manager 已运行在 127.0.0.1:8080。
此应用仅用于生成、预览、复制和下载 Xray config.json，不会读取、写入或重载本机 Xray 服务。
请勿直接暴露公网，建议使用 Caddy 反向代理。应用已内置登录保护，无需额外 BasicAuth。

{
  admin off
}

manager.example.com {
  reverse_proxy 127.0.0.1:8080
}

常用命令：
  cd /opt/xray-manager && docker compose logs -f
  cd /opt/xray-manager && docker compose restart
  cd /opt/xray-manager && docker compose down
EOF
