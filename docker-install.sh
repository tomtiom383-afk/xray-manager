#!/bin/bash
set -e

APP_NAME="xray-manager"
APP_DIR="/opt/${APP_NAME}"
GITHUB_REPO="tomtiom383-afk/xray-manager"

if [ "$(id -u)" -ne 0 ]; then
  echo "请使用 root 运行: sudo bash"
  exit 1
fi

# Interactive: ask for domain
echo "============================================"
echo "   Xray Manager 一键安装脚本"
echo "============================================"
echo ""
read -rp "请输入域名（已解析到本服务器 IP，留空跳过 HTTPS）: " DOMAIN
echo ""

# ---- [0/5] Clone from GitHub if piped via curl ----
if [ -f "${BASH_SOURCE[0]}" ] && [ "${BASH_SOURCE[0]}" != "bash" ]; then
  SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
else
  echo "[0/5] 从 GitHub 拉取项目"
  if ! command -v git &>/dev/null; then
    apt-get update -qq && apt-get install -y -qq git
  fi
  TMP_DIR=$(mktemp -d)
  git clone --depth 1 "https://github.com/${GITHUB_REPO}.git" "${TMP_DIR}"
  SOURCE_DIR="${TMP_DIR}"
fi

# ---- [1/5] Install Docker ----
if ! command -v docker &>/dev/null || { ! docker compose version &>/dev/null && ! command -v docker-compose &>/dev/null; }; then
  echo "[1/5] 安装 Docker"
  curl -fsSL https://get.docker.com | sh
else
  echo "[1/5] Docker 已安装"
fi

# ---- [2/5] Copy files ----
echo "[2/5] 复制文件到 ${APP_DIR}"
command -v rsync &>/dev/null || apt-get install -y -qq rsync
mkdir -p "${APP_DIR}"
rsync -a --delete \
  --exclude ".venv" \
  --exclude "__pycache__" \
  --exclude ".git" \
  "${SOURCE_DIR}/" "${APP_DIR}/"
[ -n "${TMP_DIR:-}" ] && rm -rf "${TMP_DIR}"

# ---- [3/5] Build and start container ----
cd "${APP_DIR}"
echo "[3/5] 构建并启动容器"
docker compose build --no-cache
docker compose up -d

# ---- [4/5] Nginx + HTTPS ----
if [ -z "${DOMAIN}" ]; then
  echo "[4/5] 未填写域名，跳过 Nginx 和 HTTPS 配置"
else
  echo "[4/5] 安装 Nginx + Certbot，申请 SSL 证书"
  apt-get update -qq
  apt-get install -y -qq nginx certbot python3-certbot-nginx

  # Write Nginx HTTP reverse proxy config
  cat > "/etc/nginx/sites-available/${APP_NAME}" <<NGINX
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN};

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
NGINX

  ln -sf "/etc/nginx/sites-available/${APP_NAME}" "/etc/nginx/sites-enabled/${APP_NAME}"
  rm -f /etc/nginx/sites-enabled/default
  nginx -t && systemctl reload nginx

  # Open firewall ports
  if command -v ufw &>/dev/null; then
    ufw allow 80/tcp  &>/dev/null || true
    ufw allow 443/tcp &>/dev/null || true
  fi

  # Request Let's Encrypt certificate
  CERTBOT_OUTPUT=$(certbot --nginx -d "${DOMAIN}" --non-interactive --agree-tos --register-unsafely-without-email --redirect 2>&1) || true

  if echo "${CERTBOT_OUTPUT}" | grep -q "Congratulations"; then
    echo "    SSL 证书申请成功"
    systemctl enable nginx
  else
    echo "    SSL 证书申请失败，Nginx HTTP 反代已生效，可稍后手动运行："
    echo "    certbot --nginx -d ${DOMAIN}"
  fi
fi

# ---- [5/5] Done ----
echo ""
echo "[5/5] 安装完成"
echo ""

if [ -n "${DOMAIN}" ] && echo "${CERTBOT_OUTPUT:-}" | grep -q "Congratulations"; then
  cat <<DONE
访问地址: https://${DOMAIN}
首次访问请创建管理员账号。

常用命令:
  cd /opt/xray-manager && docker compose logs -f
  cd /opt/xray-manager && docker compose restart
  cd /opt/xray-manager && docker compose down

更新:
  cd /opt/xray-manager && git pull && docker compose up -d --build

证书自动续期由 certbot systemd timer 处理，无需手动操作。
DONE
elif [ -n "${DOMAIN}" ]; then
  cat <<DONE
访问地址: http://${DOMAIN}（HTTPS 待配置）
首次访问请创建管理员账号。

手动申请证书: certbot --nginx -d ${DOMAIN}

常用命令:
  cd /opt/xray-manager && docker compose logs -f
  cd /opt/xray-manager && docker compose restart
DONE
else
  cat <<DONE
访问地址: http://127.0.0.1:8080（仅限本机）
首次访问请创建管理员账号。

如需 HTTPS，配置域名解析后运行:
  sudo apt install nginx certbot python3-certbot-nginx
  sudo certbot --nginx -d your-domain.com

常用命令:
  cd /opt/xray-manager && docker compose logs -f
  cd /opt/xray-manager && docker compose restart
DONE
fi
