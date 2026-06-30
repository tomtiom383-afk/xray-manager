# Xray Manager 部署指南

## 目录结构

```
xray-manager/
├── main.py              # FastAPI 后端
├── config_gen.py        # Xray 配置生成器
├── static/index.html    # 前端单页应用
├── db.json              # 本地数据库（运行后生成）
├── requirements.txt     # Python 依赖
├── Dockerfile           # Docker 镜像构建
├── docker-compose.yml   # Docker Compose 部署
└── docker-install.sh    # 一键安装脚本
```

## 内置登录保护

Xray Manager 已内置管理员注册/登录系统。首次访问时会要求创建管理员账号，之后未登录用户无法访问管理界面和 API。

- 密码使用 Argon2id 哈希存储
- 会话通过 HTTP-only Cookie 保持，支持 CSRF 防护
- 连续 5 次登录失败后该 IP 会被限流 15 分钟

### 首次使用

1. 启动服务后访问 `http://127.0.0.1:8080`
2. 按提示创建管理员账号
3. 之后访问需要登录

### 向后兼容

如果 `db.json` 中没有管理员账号且 `auth.require_auth` 为 `false`，应用允许无登录访问，但会在首页提示设置管理员。

## 方式一：一键安装（推荐）

在全新 VPS 上执行：

```bash
wget -qO install.sh https://raw.githubusercontent.com/tomtiom383-afk/xray-manager/main/docker-install.sh && bash install.sh
```

脚本会交互式询问域名（需提前解析到服务器 IP，回车跳过），然后自动完成：
1. 安装 Docker
2. 从 GitHub 拉取代码并构建容器
3. 安装 Nginx + Certbot，自动申请 Let's Encrypt 证书
4. 配置 HTTPS 反向代理，HTTP 自动跳转 HTTPS

证书续期由 certbot systemd timer 自动处理，无需手动干预。

## 方式二：手动 Docker Compose

### 1. 安装 Docker

```bash
# Ubuntu/Debian
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
# 重新登录后生效
```

### 2. 启动服务

```bash
git clone <你的仓库地址> xray-manager
cd xray-manager
docker compose up -d
```

服务会运行在 `127.0.0.1:8080`。

### 3. 查看日志

```bash
docker compose logs -f
```

### 4. 停止/重启

```bash
docker compose down      # 停止
docker compose restart   # 重启
docker compose pull      # 更新镜像后拉取
```

## 方式三：systemd + venv（传统方式）

```bash
sudo ./install.sh
```

## 反向代理（可选）

服务默认只监听 `127.0.0.1:8080`。如果需要使用域名访问，建议用 Caddy 或 Nginx 反向代理。由于应用已自带登录保护，不再需要 BasicAuth。

### Caddy 示例

```caddy
{
  admin off
}

manager.example.com {
  reverse_proxy 127.0.0.1:8080
}
```

### 强制启用/关闭登录保护

通过环境变量控制：

```yaml
environment:
  - XRAY_AUTH_REQUIRED=true   # 强制启用（无管理员时进入注册）
  - XRAY_AUTH_REQUIRED=false  # 强制关闭（仅用于紧急恢复）
```

> 注意：XRAY_AUTH_REQUIRED=false 会绕过所有认证，仅在本地调试或紧急恢复时使用。

## 数据持久化

`data/db.json` 通过 volume 挂载到宿主机，容器删除后数据不会丢失。

```yaml
volumes:
  - ./data:/app/data
```

## 备份

```bash
cp data/db.json data/db.json.$(date +%Y%m%d).bak
```

## 更新升级

```bash
cd xray-manager
git pull
docker compose build --no-cache
docker compose up -d
```

## 安全建议

- 不要直接将 `8080` 端口暴露到公网，建议通过反向代理访问
- 首次启动后立即设置强密码管理员账号
- 定期备份 `db.json`
- 生产环境建议启用 HTTPS
