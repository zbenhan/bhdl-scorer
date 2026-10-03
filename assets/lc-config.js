// 后端连接配置（自建 VPS 后端，国内直连）
// 后端部署方法见 server/README.md
window.BMOB_CONFIG = {
  appId: "bhdl-scorer",   // 任意值，后端不校验
  restKey: "",            // 与后端启动时的 API_SECRET 保持一致（随机长字符串）
  baseURL: "",            // 后端地址，例如 https://api.你的域名.com
};
