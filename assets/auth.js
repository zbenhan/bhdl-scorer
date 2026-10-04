// 鉴权与账号管理（Bmob REST 实现）
// 用户体系：_User 只存用户名+密码；档案存 profiles 表（uid 关联 _User.objectId）
// 重置密码用"代次滚动"：新建 KEY.新代次码 账号，旧档案停用，loginIndex 切到新账号
import {
  api,
  cls,
  where,
  queryOne,
  queryList,
  saveSession,
  loadSession,
  clearSession,
  parseTime,
} from "./lc.js";

export const INITIAL_PASSWORD = "000000";
export const SUPERADMIN_PASSWORD = "chaojiguanliyuan";

/** 合法分值：5 ~ 100，步长 5 */
export const SCORE_VALUES = Array.from({ length: 20 }, (_, i) => (i + 1) * 5);

/** 员工号归一化：去空白 + 大写 */
export function normId(s) {
  return String(s == null ? "" : s).trim().toUpperCase();
}

/** 生成随机代次码 */
function genToken() {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  const arr = new Uint8Array(10);
  crypto.getRandomValues(arr);
  for (const b of arr) out += chars[b % chars.length];
  return out;
}

/** 代次用户名：员工号.代次码（仅字母数字与点） */
function usernameFor(key, gen) {
  const safe = key.replace(/[^A-Z0-9]/g, "_");
  return gen ? `${safe}.${gen}` : safe;
}

/** 等待登录态首次返回（Bmob REST 无监听，直接返回会话） */
export function waitAuth() {
  return Promise.resolve(loadSession());
}

/** 占位保持接口一致 */
export async function ensureAnon() {
  return loadSession();
}

/** 员工号 + 密码登录 */
export async function loginWithEmployeeId(rawId, password) {
  const key = normId(rawId);
  if (!key) throw new Error("请输入员工号");
  if (!password) throw new Error("请输入密码");
  const idx = await queryOne("loginIndex", { key });
  if (!idx || !idx.username) throw new Error("员工号或密码错误");
  const u = await api("POST", "/1/login", {
    username: idx.username,
    password,
  });
  saveSession({
    objectId: u.objectId,
    sessionToken: u.sessionToken,
    username: u.username,
  });
}

/** profiles 行 → 页面使用的 profile 对象 */
export function profileFromRow(row) {
  return {
    id: row.objectId, // profiles 表 objectId
    uid: row.uid, // _User.objectId
    employeeId: row.employeeId || "",
    key: row.key || "",
    dept: row.dept || "",
    role: row.role || "scorer",
    gen: row.gen || null,
    active: row.active !== false,
    mustChangePassword: row.mustChangePassword === true,
    protected: row.protected === true,
    createdAt: parseTime(row.createdAt),
  };
}

/** 读取当前登录用户档案 */
export async function getCurrentProfile() {
  const s = loadSession();
  if (!s || !s.objectId) return null;
  try {
    const row = await queryOne("profiles", { uid: s.objectId });
    if (!row) return null;
    return profileFromRow(row);
  } catch (e) {
    if (e && e.code === 101) return null;
    throw e;
  }
}

export function isManagerProfile(p) {
  return p && (p.role === "admin" || p.role === "superadmin");
}

/** 各角色登录后的首页 */
export function homePath(role) {
  return role === "scorer" ? "score.html" : "admin.html";
}

/** 页面守卫 */
export async function requireProfile({ requireChanged = true } = {}) {
  const p = await getCurrentProfile();
  if (!p) {
    location.replace("index.html");
    return null;
  }
  if (p.active === false) {
    clearSession();
    location.replace(
      "index.html?msg=" + encodeURIComponent("账号已停用，请联系管理员")
    );
    return null;
  }
  if (requireChanged && p.mustChangePassword === true) {
    location.replace("change-password.html");
    return null;
  }
  return p;
}

/** 注册一个 Bmob 用户（REST 方式，不影响当前会话） */
async function createUser(username, password) {
  const r = await api("POST", "/1/users", { username, password });
  return r.objectId;
}

/**
 * 管理员新建账号
 * 初始密码 000000，mustChangePassword=true
 */
export async function managerCreateAccount({ employeeId, dept = "", role }) {
  const displayId = String(employeeId || "").trim();
  const key = normId(displayId);
  if (!key) throw new Error("请输入员工号");
  if (!["admin", "leader", "scorer"].includes(role)) throw new Error("角色非法");
  if (role === "scorer" && !String(dept).trim()) throw new Error("请填写所属部门");
  const finalDept = role === "admin" ? "人力资源部" : String(dept).trim();

  const exist = await queryOne("loginIndex", { key });
  if (exist) {
    throw new Error("该员工号已存在账号：如已停用可直接启用；如忘记密码请使用「重置密码」");
  }

  const gen = genToken();
  const username = usernameFor(key, gen);
  let uid;
  try {
    uid = await createUser(username, INITIAL_PASSWORD);
  } catch (e) {
    if (e && e.code === 202) throw new Error("该员工号已存在账号，请使用「重置密码」");
    throw e;
  }

  await api("POST", cls("profiles"), {
    uid,
    employeeId: displayId,
    key,
    dept: finalDept,
    role,
    gen,
    active: true,
    mustChangePassword: true,
    protected: false,
  });
  await api("POST", cls("loginIndex"), { key, username, uid, active: true });
  return { uid, username };
}

/**
 * 上级重置密码：新建代次账号（密码 000000），旧档案停用，loginIndex 切到新账号
 */
export async function managerResetPassword(profile) {
  if (!profile || !profile.key) throw new Error("账号信息缺失");
  if (profile.protected === true) throw new Error("固定超级管理员账号不可重置");

  const key = profile.key;
  const gen = genToken();
  const username = usernameFor(key, gen);
  const uid = await createUser(username, INITIAL_PASSWORD);

  // 新档案
  await api("POST", cls("profiles"), {
    uid,
    employeeId: profile.employeeId,
    key,
    dept: profile.dept || "",
    role: profile.role,
    gen,
    active: true,
    mustChangePassword: true,
    protected: false,
  });

  // 旧档案停用
  await api("PUT", cls("profiles") + "/" + profile.id, { active: false });

  // loginIndex 切到新代次
  const idx = await queryOne("loginIndex", { key });
  if (idx) {
    await api("PUT", cls("loginIndex") + "/" + idx.objectId, {
      username,
      uid,
      active: true,
    });
  } else {
    await api("POST", cls("loginIndex"), { key, username, uid, active: true });
  }
  return { uid };
}

/** 管理员停用/启用账号 */
export async function managerSetActive(profile, active) {
  if (profile.protected === true) throw new Error("固定超级管理员账号不可停用");
  await api("PUT", cls("profiles") + "/" + profile.id, { active: !!active });
}

/** 管理员删除打分人员：删除全部代次档案与登录索引，账号无法再登录；历史打分保留 */
export async function managerDeleteScorer(profile) {
  if (!profile || !profile.key) throw new Error("账号信息缺失");
  if (profile.role !== "scorer") throw new Error("只能删除打分人员");
  const gens = await queryList("profiles", { cond: { key: profile.key }, limit: 1000 });
  for (const g of gens) {
    await api("DELETE", cls("profiles") + "/" + g.objectId);
  }
  const idx = await queryOne("loginIndex", { key: profile.key });
  if (idx) {
    await api("DELETE", cls("loginIndex") + "/" + idx.objectId);
  }
}

/** 修改本人密码（首次强制改密时用初始密码作为原密码） */
export async function changeMyPassword(profile, { oldPassword, newPassword }) {
  const s = loadSession();
  if (!s) throw new Error("未登录");
  const pwd = String(newPassword || "");
  if (pwd.length < 6) throw new Error("新密码至少 6 位");
  if (pwd === INITIAL_PASSWORD) throw new Error("新密码不能与初始密码 000000 相同");
  if (pwd === SUPERADMIN_PASSWORD && profile.role === "superadmin") {
    throw new Error("新密码不能与当前密码相同");
  }

  const old = profile.mustChangePassword === true ? INITIAL_PASSWORD : String(oldPassword || "");
  if (!old) throw new Error("请输入原密码");

  // 带通行证提交新旧密码（成功后服务器会删除本账号所有会话）
  await api("PUT", "/1/users/" + s.objectId, {
    old_password: old,
    new_password: pwd,
  });

  // 先用新密码重新登录刷新会话，再更新档案
  const u = await api("POST", "/1/login", { username: s.username, password: pwd });
  saveSession({
    objectId: u.objectId,
    sessionToken: u.sessionToken,
    username: u.username,
  });

  if (profile.mustChangePassword === true) {
    await api("PUT", cls("profiles") + "/" + profile.id, {
      mustChangePassword: false,
    });
  }
}

/** 一次性初始化固定超级管理员 Admin / chaojiguanliyuan */
export async function bootstrapSuperAdmin() {
  const boot = await queryOne("config", { name: "bootstrap" });
  if (boot) throw new Error("ALREADY_BOOTSTRAPPED");

  const username = "ADMIN";
  let uid;
  try {
    uid = await createUser(username, SUPERADMIN_PASSWORD);
  } catch (e) {
    // 用户名已存在（202）或已有账号导致无权限新建（403）：
    // 上次初始化半途中断，尝试登录幂等继续
    if (e && (e.code === 202 || e.code === 403)) {
      const u = await api("POST", "/1/login", {
        username: "ADMIN",
        password: SUPERADMIN_PASSWORD,
      });
      uid = u.objectId;
    } else {
      throw e;
    }
  }

  // 登录为新超管（建立会话）
  const u = await api("POST", "/1/login", {
    username: "ADMIN",
    password: SUPERADMIN_PASSWORD,
  });
  saveSession({
    objectId: u.objectId,
    sessionToken: u.sessionToken,
    username: u.username,
  });

  // 档案
  const exist = await queryOne("profiles", { uid });
  if (!exist) {
    await api("POST", cls("profiles"), {
      uid,
      employeeId: "Admin",
      key: "ADMIN",
      dept: "人力资源部",
      role: "superadmin",
      gen: null,
      active: true,
      mustChangePassword: false,
      protected: true,
    });
  }

  // loginIndex
  const idx = await queryOne("loginIndex", { key: "ADMIN" });
  if (idx) {
    await api("PUT", cls("loginIndex") + "/" + idx.objectId, {
      username,
      uid,
      active: true,
    });
  } else {
    await api("POST", cls("loginIndex"), {
      key: "ADMIN",
      username,
      uid,
      active: true,
    });
  }

  // bootstrap 标记
  await api("POST", cls("config"), { name: "bootstrap", done: true, by: uid });
}

/** 顶部栏渲染 */
export function renderTopBar(profile, opts = {}) {
  const box = document.getElementById("topbar");
  if (!box || !profile) return;
  const roleText = {
    superadmin: "超级管理员",
    admin: "管理员",
    leader: "行领导",
    scorer: "打分人员",
  }[profile.role] || profile.role;
  const home = homePath(profile.role);
  box.innerHTML = `
    <div class="topbar-inner">
      <span class="brand">管理部门打分系统</span>
      <span class="badge role-${profile.role}">${roleText}</span>
      <span class="spacer"></span>
      <span class="who"><b>${escapeHtml(profile.employeeId)}</b>${
    profile.dept ? "（" + escapeHtml(profile.dept) + "）" : ""
  }</span>
      ${opts.active !== home ? `<a href="${home}">首页</a>` : ""}
      <a href="change-password.html">修改密码</a>
      <button class="linklike" id="btnLogout" type="button">退出登录</button>
    </div>`;
  document.getElementById("btnLogout").addEventListener("click", async () => {
    clearSession();
    location.replace("index.html");
  });
}

/** HTML 转义 */
export function escapeHtml(s) {
  return String(s == null ? "" : s).replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      }[c])
  );
}

/** 错误信息中文化 */
export function zhError(e) {
  const code = e && e.code != null ? String(e.code) : "";
  const msg = e && e.message ? String(e.message) : "";
  const map = {
    "101": "员工号或密码错误",
    "202": "该员工号已存在账号（如忘记密码请使用「重置密码」）",
    "206": "登录已过期，请重新登录",
    "403": "没有权限执行此操作",
    ALREADY_BOOTSTRAPPED: "系统已初始化，无需重复操作",
  };
  if (map[code]) return map[code];
  if (/old_password|password/i.test(msg) && /incorrect|error|invalid/i.test(msg))
    return "原密码错误，请重新输入";
  if (/failed to fetch|network|timeout/i.test(msg))
    return "网络异常，请检查网络后重试";
  if (/username or password incorrect/i.test(msg)) return "员工号或密码错误";
  return msg || "操作失败，请重试";
}
