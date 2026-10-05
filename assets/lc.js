// 后端 REST 轻量客户端（自建 VPS，国内直连，不依赖任何第三方 SDK）
// 依赖页面先引入：assets/lc-config.js

const cfg = window.BMOB_CONFIG || {};
export const configured = !!cfg.baseURL;

const BASE = (cfg.baseURL || "").replace(/\/+$/, "");
const SESSION_KEY = "bmob_session";
const ACTIVE_KEY = "bmob_active_ts";

// 移动端登录跳转时软键盘可能遗留缩小的视口，导致新页面下端留白：
// 页面显示（含从 bfcache 恢复）时重置到顶部，强制浏览器重新计算布局。
window.addEventListener("pageshow", () => window.scrollTo(0, 0));

/** 空闲超时时长：30 分钟无操作视为断连 */
export const IDLE_TIMEOUT_MS = 30 * 60 * 1000;

export function saveSession(s) {
  localStorage.setItem(SESSION_KEY, JSON.stringify(s));
  touchSession();
}
export function loadSession() {
  try {
    return JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
  } catch {
    return null;
  }
}
export function clearSession() {
  localStorage.removeItem(SESSION_KEY);
  localStorage.removeItem(ACTIVE_KEY);
}

/** 记录最近一次活动时间 */
export function touchSession() {
  try {
    localStorage.setItem(ACTIVE_KEY, String(Date.now()));
  } catch {}
}

function activeAt() {
  try {
    const n = parseInt(localStorage.getItem(ACTIVE_KEY) || "0", 10);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

/** 是否已因空闲超时而需要断连（未登录或首次加载不算超时） */
export function isSessionIdleExpired() {
  const s = loadSession();
  if (!s || !s.sessionToken) return false;
  const last = activeAt();
  if (!last) {
    touchSession();
    return false;
  }
  return Date.now() - last > IDLE_TIMEOUT_MS;
}

let idleWatching = false;
/**
 * 安装空闲守卫：监听用户活动刷新活动时间；周期性检测超时后清除会话并跳回登录页。
 * 多次调用只生效一次。
 */
export function watchSessionIdle() {
  if (idleWatching) return;
  idleWatching = true;
  let lastTouch = 0;
  const events = ["click", "keydown", "mousemove", "scroll", "touchstart", "wheel", "focus"];
  const onActive = () => {
    const now = Date.now();
    if (now - lastTouch < 30000) return; // 节流，避免频繁写入
    lastTouch = now;
    touchSession();
  };
  events.forEach((ev) => window.addEventListener(ev, onActive, { passive: true }));
  touchSession();
  setInterval(() => {
    if (isSessionIdleExpired()) {
      clearSession();
      const page = (location.pathname || "").split("/").pop() || "index.html";
      if (page !== "index.html") {
        location.replace(
          "index.html?msg=" + encodeURIComponent("长时间未操作，已自动退出，请重新登录")
        );
      }
    }
  }, 30000);
}

/**
 * 调用后端 REST API（自动附带当前会话通行证）
 * @param method GET/POST/PUT/DELETE
 * @param path   以 /1/ 开头的路径，可带 query string
 * @param body   对象，自动 JSON 序列化
 */
export async function api(method, path, body) {
  const headers = { "Content-Type": "application/json" };
  const s = loadSession();
  if (s && s.sessionToken) headers["X-Session-Token"] = s.sessionToken;
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body == null ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || (json && json.code != null && json.error)) {
    const err = new Error(json.error || "HTTP " + res.status);
    err.code = json.code;
    throw err;
  }
  return json;
}

/** where 条件编码 */
export function where(obj) {
  return "where=" + encodeURIComponent(JSON.stringify(obj));
}

/** 表路径 */
export function cls(name) {
  return "/1/classes/" + name;
}

/** 查询多条，返回 results 数组 */
export async function queryList(name, { cond = {}, order = "", limit = 1000 } = {}) {
  let path = cls(name) + "?" + where(cond) + "&limit=" + limit;
  if (order) path += "&order=" + encodeURIComponent(order);
  const r = await api("GET", path);
  return r.results || [];
}

/** 查询单条，没有返回 null */
export async function queryOne(name, cond = {}) {
  const list = await queryList(name, { cond, limit: 1 });
  return list[0] || null;
}

/** 计数 */
export async function queryCount(name, cond = {}) {
  const r = await api("GET", cls(name) + "?" + where(cond) + "&count=1&limit=0");
  return r.count || 0;
}

/** 解析 Bmob 时间字符串 "2026-10-03 23:33:44" → Date */
export function parseTime(s) {
  if (!s) return null;
  if (s instanceof Date) return s;
  const d = new Date(String(s).replace(" ", "T"));
  return isNaN(d.getTime()) ? null : d;
}
