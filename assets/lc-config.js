// Bmob 连接配置（国内直连，无需代理）
// 注册/登录 https://www.bmobapp.com/ → 创建应用 → 设置 → 应用密钥 中复制前两项
window.BMOB_CONFIG = {
  appId: "",    // Application ID
  restKey: "",  // REST API Key（注意：不是 Master Key，Master Key 千万不要填进来）
  baseURL: "https://api2.bmob.cn", // 一般无需修改；如文档提示用 api.bmob.cn 再改
};
