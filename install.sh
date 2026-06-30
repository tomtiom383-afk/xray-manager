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

echo "[1/5] 安装系统依赖"
if command -v apt-get >/dev/null 2>&1; then
  apt-get update
  apt-get install -y python3 python3-venv python3-pip rsync
elif command -v dnf >/dev/null 2>&1; then
  dnf install -y python3 python3-pip rsync
elif command -v yum >/dev/null 2>&1; then
  yum install -y python3 python3-pip rsync
else
  echo "未识别包管理器，请手动安装 python3、pip、venv"
fi

echo "[2/5] 复制文件到 ${APP_DIR}"
mkdir -p "${APP_DIR}"
rsync -a --delete \
  --exclude ".venv" \
  --exclude "__pycache__" \
  "${SOURCE_DIR}/" "${APP_DIR}/"

echo "[3/5] 创建 Python 虚拟环境并安装依赖"
python3 -m venv "${APP_DIR}/.venv"
"${APP_DIR}/.venv/bin/pip" install --upgrade pip
"${APP_DIR}/.venv/bin/pip" install -r "${APP_DIR}/requirements.txt"

echo "[4/5] 写入 systemd 服务"
cat > "${SERVICE_FILE}" <<EOF
[Unit]
Description=Lightweight Xray Manager
After=network.target

[Service]
Type=simple
User=nobody
WorkingDirectory=${APP_DIR}
ExecStart=${APP_DIR}/.venv/bin/uvicorn main:app --host 127.0.0.1 --port 8080
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now "${APP_NAME}"

echo "[5/5] 安装完成"
cat <<'EOF'

服务已绑定在 127.0.0.1:8080。
此应用仅用于生成、预览、复制和下载 Xray config.json，不会读取、写入或重载本机 Xray 服务。
请勿直接暴露公网，建议使用 Caddy 反向代理。应用已内置登录保护，无需额外 BasicAuth。

{
  admin off
}

manager.example.com {
  reverse_proxy 127.0.0.1:8080
}

常用命令：
  systemctl status xray-manager
  journalctl -u xray-manager -f
EOF
