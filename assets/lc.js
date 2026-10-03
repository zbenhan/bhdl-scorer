// Bmob REST API 轻量客户端（国内直连，无需代理，不依赖任何第三方 SDK）
// 依赖页面先引入：assets/lc-config.js

const cfg = window.BMOB_CONFIG || {};
export const configured = !!(cfg.appId && cfg.restKey);

const BASE = (cfg.baseURL || "https://api2.bmob.cn").replace(/\/+$/, "");
const SESSION_KEY = "bmob_session";

export function saveSession(s) {
  localStorage.setItem(SESSION_KEY, JSON.stringify(s));
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
}

/**
 * 调用 Bmob REST API
 * @param method GET/POST/PUT/DELETE
 * @param path   以 /1/ 开头的路径，可带 query string
 * @param body   对象，自动 JSON 序列化
 * @param useSession 是否附带当前登录用户的 SessionToken
 */
export async function api(method, path, body, useSession = false) {
  const headers = {
    "X-Bmob-Application-Id": cfg.appId,
    "X-Bmob-REST-API-Key": cfg.restKey,
    "Content-Type": "application/json",
  };
  if (useSession) {
    const s = loadSession();
    if (s && s.sessionToken) headers["X-Bmob-Session-Token"] = s.sessionToken;
  }
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
