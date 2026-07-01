# Xray Manager

Xray-core 配置生成与管理工具，提供 **Windows 桌面客户端**和 **VPS Web 部署**两种使用方式。管理入站、出站、用户和分流策略，一键生成 `config.json`。

> ⚠️ 本工具**只生成配置**，不操作本机 Xray 服务。配置需手动复制到节点使用。

---

## 选择你的使用方式

### 🖥️ Windows 桌面客户端 — 最简单

下载安装即用，免登录，打开就能管节点。

👉 **[下载 Xray Manager v0.1.0](https://github.com/tomtiom383-afk/xray-manager/releases/latest)**（~12MB, Windows x64）

> 数据保存在安装目录 `data/` 内，卸载时勾选"删除用户数据"彻底清除。

### ☁️ VPS Web 部署 — 团队共享

一条命令部署到 VPS，通过浏览器访问，支持多人管理。

```bash
git clone https://github.com/tomtiom383-afk/xray-manager.git && bash xray-manager/docker-install.sh
```

脚本自动完成 Docker + Nginx + Let's Encrypt SSL 部署。

### 更多部署方式

| 方式 | 命令 | 适合 |
|------|------|------|
| Docker Compose 手动 | `git clone ... && mkdir -p data && docker compose up -d` | 已有 Docker |
| systemd | `chmod +x install.sh && sudo ./install.sh` | 裸机 |
| 已有 Nginx + SNI 分流 + 泛域名证书 | 见 [手动接入](#已有-nginx--sni-分流--泛域名证书) | 已有站群 |

---

## 功能特性

- **入站协议**：VLESS + REALITY、Shadowsocks 2022
- **出站协议**：VLESS、Shadowsocks、直连、黑洞
- **用户级分流**：中国大陆直连、广告拦截、BT 拦截、AI 服务分流、自定义规则
- **多 VPS Profile**：一个面板管理多个节点配置
- **分享链接解析**：支持 `vless://` / `ss://` 导入
- **密钥工具**：x25519 密钥对、UUID、Shadowsocks PSK
- **VPS 端认证**：Argon2id 密码哈希、CSRF 防护、登录限流
- **桌面端**：免登录、系统托盘、单文件安装、卸载零残留

---

## 技术栈

| 组件 | 技术 |
|------|------|
| 后端 | FastAPI + Uvicorn |
| 桌面壳 | Tauri v2 + Rust |
| 前端 | 原生 JavaScript |
| 存储 | JSON 文件 |
| 认证 | Argon2id (VPS 端) |

---

## 目录结构

```
xray-manager/
├── main.py              # FastAPI 后端
├── config_gen.py        # Xray 配置生成器
├── static/              # 前端 (原生 JS)
├── data/                # 数据目录 (.gitignore)
├── src-tauri/           # 桌面客户端 (Tauri v2 + Rust)
├── requirements.txt     # Python 依赖
├── docker-compose.yml
├── docker-install.sh    # 一键部署脚本
├── install.sh           # systemd 安装脚本
└── LICENSE              # MIT
```

---

## 已有 Nginx / SNI 分流 / 泛域名证书

如果你的 VPS 已有 Nginx 使用 stream SNI 分流 + 泛域名证书，按以下步骤手动接入：

**1. 启动容器：**
```bash
git clone https://github.com/tomtiom383-afk/xray-manager.git
cd xray-manager && mkdir -p data && docker compose up -d
```

**2. 添加 SNI 分流规则：**
```nginx
# /etc/nginx/stream.d/sni_split.conf
map $ssl_preread_server_name $upstream_443 {
    xray.example.com  127.0.0.1:8081;
    default           444;
}
```

**3. 添加 HTTPS server 块：**
```nginx
server {
    listen 127.0.0.1:8081 ssl;
    server_name xray.example.com;
    ssl_certificate     /etc/nginx/ssl/example.com.pem;
    ssl_certificate_key /etc/nginx/ssl/example.com.key;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
    }
}
```

**4. 重载：** `nginx -t && nginx -s reload`

---

## 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `XRAY_AUTH_REQUIRED` | `true` | `false` 跳过登录（紧急恢复） |
| `XRAY_COOKIE_SECURE` | `true`(Docker) | HTTPS 环境保持 `true` |

---

## 安全说明

- VPS 端密码 Argon2id 哈希存储
- Cookie: HTTP-only + Secure + SameSite=Strict
- CSRF Token 验证 + 登录限流
- 推荐 Cloudflare 代理隐藏源站 IP

---

## 常见问题

**部署后 8080 打不开？** `docker ps` / `systemctl status xray-manager` 检查状态

**忘记密码？** `XRAY_AUTH_REQUIRED=false docker compose up -d` 临时跳过认证重新注册

**证书续期？** `certbot renew --nginx` / `systemctl status certbot.timer`

**VLESS 链接怎么导入？** 进入「用户」页面 → 「导入分享链接」

---

## License

MIT
