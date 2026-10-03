// LeanCloud 初始化（国内节点直连，无需代理）
// 依赖页面先引入：assets/lc-config.js 与 av-min.js

const cfg = window.LC_CONFIG || {};
export const configured = !!(cfg.appId && cfg.appKey && cfg.serverURL);

if (configured) {
  AV.init({
    appId: cfg.appId,
    appKey: cfg.appKey,
    serverURL: cfg.serverURL,
  });
}

export default AV;
