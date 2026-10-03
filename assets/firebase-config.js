/**
 * Firebase 配置文件
 * ---------------------------------------------------------------
 * 请到 Firebase 控制台（https://console.firebase.google.com）：
 *   1. 新建（或选择）项目
 *   2. 项目设置 → 常规 → 您的应用 → 注册一个 Web 应用
 *   3. 把 firebaseConfig 对象中的值原样粘贴到下方
 *   4. 保存本文件并重新部署即可
 *
 * 说明：Firebase Web API key 本身设计为公开（写在前端是官方常规做法），
 * 数据安全由 firestore.rules 安全规则保证，不属于泄密。
 */
window.FIREBASE_CONFIG = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT_ID.appspot.com",
  messagingSenderId: "YOUR_MESSAGING_SENDER_ID",
  appId: "YOUR_APP_ID"
};
