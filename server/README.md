# 打分系统后端部署指南

## 前提条件

- 一台 VPS（国内或海外均可，确保你的用户能访问）
- 一个域名（如 `api.example.com`）
- VPS 上安装 Node.js 18+（若没装：`apt install nodejs` 或去 https://nodejs.org 下载）

## 1. 上传文件

把本目录 `server.js` 和 `data.json`（后者首次可空文件或不存在，会自动创建）上传到你 VPS 的某个目录，例如：

```
/opt/bhdl-scorer/
```

## 2. 设置 API_SECRET（重要！）

`API_SECRET` 是前端的"密码"，必须与 `assets/lc-config.js` 里的 `restKey` 一致。

生成随机字符串：

```bash
openssl rand -base64 32
```

## 3. 启动后端

```bash
cd /opt/bhdl-scorer
API_SECRET="你的随机字符串" node server.js
```

默认监听 `3000` 端口，可改环境变量 `PORT=xxxx`。

## 4. HTTPS 配置（必须）

GitHub Pages 是 HTTPS，浏览器不允许它调用 HTTP 接口。必须用 HTTPS。

**推荐方案：Caddy（自动 HTTPS，最简单）**

```bash
# 安装 Caddy（Ubuntu/Debian）
apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
apt update && apt install caddy
```

创建 `/etc/caddy/Caddyfile`：

```
scorer-api.yourdomain.com {
    reverse_proxy localhost:3000
}
```

启动 Caddy：

```bash
systemctl restart caddy
```

Caddy 会自动从 Let's Encrypt 申请 HTTPS 证书，全程无需手动操作。

**若你已有 Nginx**：配置一个 `proxy_pass` 到 `http://127.0.0.1:3000`，然后 `certbot --nginx` 申请证书。

## 5. 前端配置

把 `assets/lc-config.js` 改成你的域名：

```js
window.BMOB_CONFIG = {
  appId: "打分系统",  // 任意填，后端不校验
  restKey: "你的API_SECRET",
  baseURL: "https://scorer-api.yourdomain.com",
};
```

## 6. 常驻运行（可选但建议）

用 `systemd` 或 `pm2` 让后端开机自启。最简单：`nohup` 或 `screen`，但推荐 `pm2`：

```bash
npm install -g pm2
pm2 start server.js --name bhdl-server --env API_SECRET="你的随机字符串"
pm2 save
pm2 startup
```

## 7. 备份

数据就是 `data.json` 一个文件，定期复制备份即可：

```bash
cp data.json "data-$(date +%Y%m%d).json"
```
