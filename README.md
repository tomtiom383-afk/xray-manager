# Xray Manager

Xray-core 配置生成与管理工具。通过 Web 界面管理入站、出站、用户和分流策略，一键生成完整的 `config.json`，支持多 VPS Profile 切换和分享链接导入。

> ⚠️ 本工具**只生成配置**，不读取、不写入、不重载本机 Xray 服务。你需要手动将生成的配置复制到目标 VPS 上运行。

---

## 功能特性

### 入站协议
- **VLESS + REALITY**：完整的 REALITY 配置生成，支持 `xtls-rprx-vision` flow
- **Shadowsocks 2022**：支持 `2022-blake3-aes-128-gcm` / `2022-blake3-aes-256-gcm`

### 出站协议
- **VLESS**：用于连接上游服务器
- **Shadowsocks**：用于连接上游服务器
- **直连 / 黑洞**：内置 direct 和 block 出站

### 用户级分流
- 按用户绑定出站或分流策略
- 支持分流策略预设：
  - 中国大陆直连（geosite:cn / geoip:cn）
  - 广告拦截（geosite:category-ads-all）
  - BT 协议拦截
  - AI 服务分流（OpenAI / Claude / Gemini 等）
  - 局域网直连
- 支持自定义域名 / IP / 协议规则

### 其他功能
- **多 VPS Profile**：同一实例管理多台服务器配置，一键切换
- **配置预览**：实时生成并预览完整 Xray `config.json`
- **分享链接导入**：支持 `vless://` 和 `ss://` 链接解析
- **内置认证**：管理员注册/登录，Argon2id 密码哈希，CSRF 防护，登录限流
- **密钥工具**：在线生成 x25519 密钥对、UUID、Shadowsocks PSK

---

## 技术栈

| 组件 | 技术 |
|------|------|
| 后端 | FastAPI + Uvicorn |
| 前端 | 原生 JavaScript（无框架，单页应用）|
| 存储 | JSON 文件（`data/db.json`）|
| 认证 | Argon2id + HTTP-only Cookie + CSRF Token |
| 密钥生成 | x25519（REALITY 密钥对）|

---

## 系统要求

### VPS 一键部署
- 干净的 Linux 服务器（Ubuntu / Debian 推荐）
- 1 核 CPU / 1GB 内存 / 5GB 硬盘
- 域名已解析到服务器 IP（可选，用于 HTTPS）

### 本地开发 / Windows
- Windows 10/11
- Docker Desktop（含 WSL2 后端）
- 或 Python 3.10+ 环境

---

## 快速开始

### 方式一：VPS 一键安装（推荐）

在干净的 VPS 上执行：

```bash
git clone https://github.com/tomtiom383-afk/xray-manager.git && bash xray-manager/docker-install.sh
```

脚本会交互式询问域名，然后自动完成：
1. 检查并安装 Docker
2. 从 GitHub 拉取代码并构建容器
3. 安装 Nginx + Certbot，自动申请 Let's Encrypt SSL 证书
4. 配置 HTTPS 反向代理，HTTP 自动跳转 HTTPS

回车跳过域名则仅本机 HTTP 访问。

安装完成后会输出访问地址和常用命令。

### 方式二：手动 Docker Compose

适合已有 Docker 环境或需要自定义配置：

```bash
git clone https://github.com/tomtiom383-afk/xray-manager.git
cd xray-manager
mkdir -p data
docker compose up -d
```

访问 `http://127.0.0.1:8080`。

### 方式三：systemd 部署（不依赖 Docker）

适合不想使用 Docker 的环境：

```bash
git clone https://github.com/tomtiom383-afk/xray-manager.git
cd xray-manager
chmod +x install.sh
sudo ./install.sh
```

服务以 `nobody` 用户运行，监听 `127.0.0.1:8080`。

### 方式四：本地 Windows 开发

#### 前置条件

安装 [Docker Desktop](https://www.docker.com/products/docker-desktop/)（含 WSL2 后端）。

#### 启动

```powershell
git clone https://github.com/tomtiom383-afk/xray-manager.git
cd xray-manager
mkdir -p data
docker compose up -d
```

访问 `http://localhost:8080`。

> Windows 本地 HTTP 环境下 `XRAY_COOKIE_SECURE` 自动为 `false`，不需要额外配置。

### 方式五：已有 Nginx / SNI 分流 / 泛域名证书

如果你的机器已经部署了 Nginx，并使用 **stream 层 SNI 分流** + **泛域名证书**（如 Cloudflare 源证书），不要运行一键安装脚本，按以下步骤手动接入：

1. 用 Docker Compose 启动 Xray Manager：

```bash
git clone https://github.com/tomtiom383-afk/xray-manager.git
cd xray-manager
mkdir -p data
docker compose up -d
```

2. 在 SNI 分流配置中，把子域名指向本地 HTTPS 端口（例如 `127.0.0.1:8081`）：

```nginx
# /etc/nginx/stream.d/sni_split.conf
map $ssl_preread_server_name $upstream_443 {
    # ... 其他站点
    xray.example.com          127.0.0.1:8081;
    default                   444;
}
```

3. 在 HTTP Nginx 中新增一个 `server` 块，监听本地 SSL 端口，使用泛域名证书：

```nginx
server {
    listen 127.0.0.1:8081 ssl;
    server_name xray.example.com;

    ssl_certificate     /etc/nginx/ssl/example.com.pem;
    ssl_certificate_key /etc/nginx/ssl/example.com.key;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
    }
}
```

4. 重载 Nginx：

```bash
nginx -t && nginx -s reload
```

> 一键安装脚本会尝试安装 Nginx 并申请 Let's Encrypt 证书，在已有 Nginx + SNI 分流的环境中可能失败，建议直接手动接入。

---

## 首次使用

1. 打开部署后的访问地址
2. 点击「创建管理员账号」，设置用户名和密码
3. 登录后进入管理界面
4. 依次配置：
   - **VPS Profile**：至少保留一个默认配置
   - **入站**：创建 VLESS + REALITY 或 Shadowsocks 2022 入站
   - **用户**：为入站创建用户，分配 UUID 或密码
   - **出站**：添加上游服务器（可选）
   - **分流策略**：按需创建分流规则（可选）
5. 在「配置预览」页面生成完整 Xray `config.json`
6. 复制配置到目标 VPS 的 Xray 配置文件中

---

## 反向代理（生产环境必须）

> ⚠️ 本工具存储 VPS 密钥、用户 UUID 等敏感数据，**必须通过 HTTPS 访问**，禁止将 8080 端口直接暴露到公网。

### 推荐方案：Cloudflare + Nginx

1. 将域名添加到 Cloudflare，DNS 记录指向 VPS IP，**开启橙色云朵（Proxy）**
2. SSL/TLS 加密模式选择 **Full（Strict）**
3. 运行一键安装脚本，或手动配置 Nginx：

```nginx
server {
    listen 443 ssl;
    server_name manager.example.com;

    ssl_certificate     /etc/letsencrypt/live/manager.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/manager.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header CF-Connecting-IP $http_cf_connecting_ip;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

4. Cloudflare → Rules → 开启 **Always Use HTTPS** 和 **Automatic HTTPS Rewrites**

> 使用 Cloudflare 时，应用会自动读取 `CF-Connecting-IP` 头获取真实访客 IP，登录限流按真实 IP 生效。

### 方案二：Caddy

```caddy
{
  admin off
}

manager.example.com {
  reverse_proxy 127.0.0.1:8080
}
```

Caddy 会自动申请并续期 Let's Encrypt 证书。

---

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `XRAY_AUTH_REQUIRED` | `true` | 设为 `false` 可跳过登录（仅紧急恢复时使用）|
| `XRAY_COOKIE_SECURE` | `true`（Docker）/ `false`（本地） | HTTPS 环境保持 `true`；本地 HTTP 调试时保持 `false` |

### 紧急恢复

如果忘记管理员密码，可临时禁用认证：

```bash
# Docker 部署
docker compose down
cd /opt/xray-manager && XRAY_AUTH_REQUIRED=false docker compose up -d

# 或修改 docker-compose.yml
docker compose up -d
```

> ⚠️ 禁用认证后务必立即重新注册管理员，然后恢复 `XRAY_AUTH_REQUIRED=true`。

---

## 目录结构

```
xray-manager/
├── main.py              # FastAPI 后端 + 认证
├── config_gen.py        # Xray 配置生成器
├── static/              # 前端资源
│   ├── index.html
│   ├── css/style.css
│   └── js/
│       ├── foundation.js
│       └── interface.js
├── data/                # 数据目录（运行后生成，已 gitignore）
│   └── db.json          # 本地数据库
├── requirements.txt     # Python 依赖
├── Dockerfile
├── docker-compose.yml
├── docker-install.sh    # Docker 一键安装脚本
├── install.sh           # systemd 一键安装脚本
├── DEPLOY.md            # 详细部署文档
├── README.md            # 本文件
└── LICENSE              # MIT 许可证
```

---

## 数据备份与迁移

### 备份

```bash
# Docker 部署
cd /opt/xray-manager
cp data/db.json data/db.json.$(date +%Y%m%d).bak

# systemd 部署
cp /opt/xray-manager/data/db.json /opt/xray-manager/data/db.json.$(date +%Y%m%d).bak
```

### 迁移

```bash
# 1. 在旧机器上备份
cp /opt/xray-manager/data/db.json ./db.json

# 2. 在新机器上恢复
cp ./db.json /opt/xray-manager/data/db.json
cd /opt/xray-manager && docker compose restart
```

---

## 更新升级

```bash
cd /opt/xray-manager
git pull

# Docker 部署
docker compose build --no-cache
docker compose up -d

# systemd 部署
sudo ./install.sh
```

---

## 安全说明

- **必须通过 HTTPS 访问**，禁止将 8080 端口直接暴露到公网
- 密码使用 Argon2id 哈希存储，不可逆
- 会话通过 HTTP-only + SameSite=Strict + Secure Cookie 保持
- 写操作均要求 CSRF Token 验证（时间安全比较）
- 登录失败 5 次后该 IP 限流 15 分钟（支持 `CF-Connecting-IP` / `X-Forwarded-For` 真实 IP 识别）
- 推荐使用 Cloudflare 代理，隐藏源站 IP 并获得免费 HTTPS

---

## 常见问题

### Q1：部署后 8080 端口无法访问？

检查容器/服务状态：

```bash
# Docker
docker ps
docker compose logs

# systemd
systemctl status xray-manager
journalctl -u xray-manager -f
```

### Q2：忘记管理员密码怎么办？

临时禁用认证后重新注册：

```bash
# Docker 部署
cd /opt/xray-manager
XRAY_AUTH_REQUIRED=false docker compose up -d
```

然后访问 `http://127.0.0.1:8080` 重新注册管理员。

### Q3：证书续期失败？

```bash
sudo certbot renew --nginx
```

或检查 Certbot 定时任务：

```bash
systemctl status certbot.timer
```

### Q4：VLESS 链接如何导入？

进入「用户」页面，点击「导入分享链接」，粘贴 `vless://` 或 `ss://` 链接即可。

---

## 开发

### 本地运行（不依赖 Docker）

```bash
cd xray-manager
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --host 127.0.0.1 --port 8080 --reload
```

前端修改后刷新浏览器即可生效。

### 构建 Docker 镜像

```bash
docker build -t xray-manager .
```

---

## 贡献

欢迎提交 Issue 和 Pull Request。主要开发方向：

- 支持更多入站协议
- 支持更多出站协议
- 导入/导出配置
- WebSocket / gRPC 传输层增强
- 多语言支持

---

## 许可证

MIT License
