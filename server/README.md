# 打分系统后端部署指南

## 前提条件

- 一台 VPS（确保你的用户能访问；国内 VPS 无需代理）
- 一个域名（HTTPS 需要，如 `api.example.com`）
- VPS 上安装 Node.js 18+（`node --version` 检查；没有则 `apt install nodejs`）

## 1. 上传文件

把 `server/server.js` 上传到 VPS 某个目录，例如 `/opt/bhdl-scorer/`

## 2. 启动后端

```bash
cd /opt/bhdl-scorer
node server.js
```

默认监听 `3000` 端口（环境变量 `PORT` 可改）。数据自动保存在同目录 `data.json`。

## 3. HTTPS 配置（必须）

GitHub Pages 是 HTTPS，浏览器不允许它调用 HTTP 接口。

**推荐 Caddy（自动申请免费 HTTPS 证书，最省心）**

```bash
apt install caddy
```

编辑 `/etc/caddy/Caddyfile`：

```
api.你的域名.com {
    reverse_proxy localhost:3000
}
```

```bash
systemctl restart caddy
```

（域名需要先做一条 A 记录指向 VPS IP）

## 4. 前端配置

编辑 `assets/lc-config.js`：

```js
window.BMOB_CONFIG = {
  baseURL: "https://api.你的域名.com",
};
```

提交推送到 GitHub，等 GitHub Pages 部署完成。

## 5. 初始化（重要：部署后立刻做）

访问 `https://zbenhan.github.io/bhdl-scorer/setup.html` 点"一键初始化"。

> 初始化完成前存在极短的"开放窗口"（系统无任何账号时允许建首个账号），
> 所以部署后请第一时间完成初始化。

## 6. 常驻运行（建议）

```bash
npm install -g pm2
pm2 start server.js --name bhdl-server
pm2 save
pm2 startup
```

## 7. 备份

数据就是 `data.json` 一个文件，定期复制备份即可：

```bash
cp data.json "data-$(date +%Y%m%d).json"
```

## 8. 本地测试（可选）

```bash
node server/test.js   # 29 项权限测试应全部 PASS
```
