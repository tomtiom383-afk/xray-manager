# Xray Manager

Xray-core 配置生成与管理工具。通过 Web 界面管理入站、出站、用户和分流策略，一键生成 `config.json`，支持多 VPS Profile 切换。

---

## 功能特性

- **多协议入站**：VLESS + REALITY、Shadowsocks 2022
- **多协议出站**：VLESS、Shadowsocks、直连、黑洞
- **用户级分流**：按用户绑定出站或分流策略，支持预设（中国大陆直连、广告拦截、BT 拦截、AI 服务分流）和自定义规则
- **多 VPS Profile**：同一实例管理多台服务器配置，一键切换
- **配置预览**：生成完整 Xray config.json，支持复制和下载，不直接操作本机 Xray 服务
- **内置认证**：管理员注册/登录，Argon2id 密码哈希，CSRF 防护，登录限流
- **分享链接导入**：支持 `vless://` 和 `ss://` 链接解析

## 技术栈

| 组件 | 技术 |
|------|------|
| 后端 | FastAPI + Uvicorn |
| 前端 | 原生 JavaScript（无框架）|
| 存储 | JSON 文件（`db.json`）|
| 认证 | Argon2id + HTTP-only Cookie |
| 密钥生成 | x25519（REALITY 密钥对）|

## 快速开始

### Docker Compose（推荐）

```bash
git clone https://github.com/<your-username>/xray-manager.git
cd xray-manager
docker compose up -d
```

访问 `http://127.0.0.1:8080`，首次使用按提示创建管理员账号。

### 一键安装脚本（VPS）

将项目上传至 VPS 后执行：

```bash
chmod +x docker-install.sh
sudo ./docker-install.sh
```

脚本会自动安装 Docker、构建镜像并启动服务。

### systemd 部署（不依赖 Docker）

```bash
chmod +x install.sh
sudo ./install.sh
```

服务以 `nobody` 用户运行，监听 `127.0.0.1:8080`。

## 反向代理（必须）

> ⚠️ 本工具存储 VPS 密钥、用户 UUID 等敏感数据，**必须通过 HTTPS 访问**，禁止将 8080 端口直接暴露到公网。推荐使用 Cloudflare 反向代理，同时获得免费 HTTPS 和 IP 隐藏。

### Cloudflare 配置步骤

1. 将域名添加到 Cloudflare，DNS 记录指向 VPS IP，**开启橙色云朵（Proxy）**
2. SSL/TLS 加密模式选择 **Full（Strict）**
3. 在 VPS 上用 Caddy 做本地反代（自动签发证书给 CF 验证）：

```caddy
{
  admin off
}

manager.example.com {
  reverse_proxy 127.0.0.1:8080
}
```

或使用 Nginx：

```nginx
server {
    listen 443 ssl;
    server_name manager.example.com;

    ssl_certificate     /etc/ssl/certs/manager.example.com.pem;
    ssl_certificate_key /etc/ssl/private/manager.example.com.key;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header CF-Connecting-IP $http_cf_connecting_ip;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

4. Cloudflare → Rules → 开启 **Always Use HTTPS** 和 **Automatic HTTPS Rewrites**

> 使用 Cloudflare 时，应用会自动读取 `CF-Connecting-IP` 头获取真实访客 IP，登录限流按真实 IP 生效。

## 本地 Windows 部署（开发 / 个人使用）

### 前置条件

安装 [Docker Desktop](https://www.docker.com/products/docker-desktop/)（含 WSL2 后端）。

### 启动

```powershell
git clone https://github.com/<your-username>/xray-manager.git
cd xray-manager

# 开发模式：关闭 Secure Cookie（本地 HTTP 环境）
docker compose up -d --env-file .env.dev
```

创建 `.env.dev`（可选，覆盖默认值）：

```
XRAY_COOKIE_SECURE=false
```

访问 `http://localhost:8080`。

> 本地 Windows 部署仅适合个人使用。如需多人访问或暴露到网络，务必配置 HTTPS。

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `XRAY_AUTH_REQUIRED` | `true` | 设为 `false` 可跳过登录（仅紧急恢复时使用）|
| `XRAY_COOKIE_SECURE` | `true`（Docker）/ `false`（本地） | HTTPS 环境保持 `true`；本地 HTTP 调试时设为 `false` |

## 目录结构

```
xray-manager/
├── main.py              # FastAPI 后端 + 认证
├── config_gen.py        # Xray 配置生成器
├── static/
│   ├── index.html       # 单页应用入口
│   ├── css/style.css    # 样式
│   └── js/
│       ├── foundation.js # 基础工具函数
│       └── interface.js  # UI 逻辑
├── db.json              # 本地数据库（运行后自动生成，已 gitignore）
├── requirements.txt     # Python 依赖
├── Dockerfile
├── docker-compose.yml
├── docker-install.sh    # Docker 一键安装脚本
├── install.sh           # systemd 一键安装脚本
└── DEPLOY.md            # 详细部署文档
```

## 数据备份

`db.json` 是所有配置的存储文件，定期备份即可：

```bash
cp db.json db.json.$(date +%Y%m%d).bak
```

Docker 部署时 `db.json` 通过 volume 挂载到宿主机，容器删除不影响数据。

## 更新

```bash
cd xray-manager
git pull

# Docker 部署
docker compose build --no-cache
docker compose up -d

# systemd 部署
sudo ./install.sh
```

## 安全说明

- **必须通过 HTTPS 访问**，禁止将 8080 端口直接暴露到公网
- 密码使用 Argon2id 哈希存储，不可逆
- 会话通过 HTTP-only + SameSite=Strict + Secure Cookie 保持
- 写操作均要求 CSRF Token 验证（时间安全比较）
- 登录失败 5 次后该 IP 限流 15 分钟（支持 `CF-Connecting-IP` / `X-Forwarded-For` 真实 IP 识别）
- 推荐使用 Cloudflare 代理，隐藏源站 IP 并获得免费 HTTPS

## License

MIT
