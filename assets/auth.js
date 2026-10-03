// 鉴权与账号管理（LeanCloud 实现）
// 保留原函数签名，页面逻辑无需大改
import "./lc.js";

export const INITIAL_PASSWORD = "000000";
export const SUPERADMIN_PASSWORD = "chaojiguanliyuan";
export const EMAIL_DOMAIN = "scorer.local";

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

/** 代次用户名：员工号.代次码（仅字母数字与点，LeanCloud 用户名允许） */
function usernameFor(key, gen) {
  const safe = key.replace(/[^A-Z0-9]/g, "_");
  return `${safe}.${gen}`;
}

/** 等待登录态首次返回（LeanCloud 是同步的，直接返回当前用户） */
export function waitAuth() {
  return Promise.resolve(AV.User.current());
}

/** LeanCloud 无需匿名会话，占位保持接口一致 */
export async function ensureAnon() {
  return AV.User.current();
}

/** 通过 loginIndex 解析当前生效的用户名 */
async function resolveUsername(key) {
  const q = new AV.Query("loginIndex");
  q.equalTo("key", key);
  const idx = await q.first();
  if (!idx) return null;
  return idx.get("username");
}

/** 员工号 + 密码登录 */
export async function loginWithEmployeeId(rawId, password) {
  const key = normId(rawId);
  if (!key) throw new Error("请输入员工号");
  if (!password) throw new Error("请输入密码");
  const username = await resolveUsername(key);
  if (!username) throw new Error("员工号或密码错误");
  await AV.User.logIn(username, password);
}

/** 把 AV.User 转成页面使用的 profile 对象 */
function userToProfile(u) {
  if (!u) return null;
  return {
    id: u.id,
    uid: u.id,
    employeeId: u.get("employeeId") || "",
    key: u.get("key") || "",
    dept: u.get("dept") || "",
    role: u.get("role") || "scorer",
    gen: u.get("gen") || null,
    active: u.get("active") !== false,
    mustChangePassword: u.get("mustChangePassword") === true,
    protected: u.get("protected") === true,
    createdAt: u.createdAt ? { seconds: Math.floor(u.createdAt.getTime() / 1000) } : null,
  };
}

/** 读取当前登录用户档案 */
export async function getCurrentProfile() {
  const u = AV.User.current();
  if (!u) return null;
  try {
    await u.fetch();
  } catch (e) {
    return null;
  }
  if (!u.get("role")) return null; // 非本系统账号
  return userToProfile(u);
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
    await AV.User.logOut();
    location.replace("index.html?msg=" + encodeURIComponent("账号已停用，请联系管理员"));
    return null;
  }
  if (requireChanged && p.mustChangePassword === true) {
    location.replace("change-password.html");
    return null;
  }
  return p;
}

/** 检查员工号是否已存在 */
async function keyExists(key) {
  const q = new AV.Query("loginIndex");
  q.equalTo("key", key);
  const idx = await q.first();
  return !!idx;
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

  if (await keyExists(key)) {
    throw new Error("该员工号已存在账号：如已停用可直接启用；如忘记密码请使用「重置密码」");
  }

  const gen = genToken();
  const username = usernameFor(key, gen);

  const user = new AV.User();
  user.set("username", username);
  user.set("password", INITIAL_PASSWORD);
  user.set("employeeId", displayId);
  user.set("key", key);
  user.set("dept", finalDept);
  user.set("role", role);
  user.set("gen", gen);
  user.set("active", true);
  user.set("mustChangePassword", true);
  user.set("protected", false);
  await user.signUp();

  const idx = new AV.Object("loginIndex");
  idx.set("key", key);
  idx.set("username", username);
  idx.set("uid", user.id);
  idx.set("active", true);
  await idx.save();

  return { uid: user.id, username };
}

/**
 * 上级重置密码：新建一个代次账号（密码 000000），旧代次停用，loginIndex 切到新代次
 */
export async function managerResetPassword(profile) {
  if (!profile || !profile.key) throw new Error("账号信息缺失");
  if (profile.protected === true) throw new Error("固定超级管理员账号不可重置");

  const key = profile.key;
  const gen = genToken();
  const username = usernameFor(key, gen);

  const user = new AV.User();
  user.set("username", username);
  user.set("password", INITIAL_PASSWORD);
  user.set("employeeId", profile.employeeId);
  user.set("key", key);
  user.set("dept", profile.dept || "");
  user.set("role", profile.role);
  user.set("gen", gen);
  user.set("active", true);
  user.set("mustChangePassword", true);
  user.set("protected", false);
  await user.signUp();

  // 旧代次停用
  const oldU = AV.Object.createWithoutData("_User", profile.id);
  oldU.set("active", false);
  await oldU.save();

  // loginIndex 切到新代次
  const q = new AV.Query("loginIndex");
  q.equalTo("key", key);
  const idx = await q.first();
  if (idx) {
    idx.set("username", username);
    idx.set("uid", user.id);
    idx.set("active", true);
    await idx.save();
  } else {
    const ni = new AV.Object("loginIndex");
    ni.set("key", key);
    ni.set("username", username);
    ni.set("uid", user.id);
    ni.set("active", true);
    await ni.save();
  }
  return { uid: user.id };
}

/** 管理员停用/启用账号 */
export async function managerSetActive(profile, active) {
  if (profile.protected === true) throw new Error("固定超级管理员账号不可停用");
  const u = AV.Object.createWithoutData("_User", profile.id);
  u.set("active", !!active);
  await u.save();
}

/** 管理员修改打分人员所属部门 */
export async function managerUpdateDept(profile, dept) {
  const u = AV.Object.createWithoutData("_User", profile.id);
  u.set("dept", String(dept || "").trim());
  await u.save();
}

/** 修改本人密码 */
export async function changeMyPassword(profile, { oldPassword, newPassword }) {
  const u = AV.User.current();
  if (!u) throw new Error("未登录");
  const pwd = String(newPassword || "");
  if (pwd.length < 6) throw new Error("新密码至少 6 位");
  if (pwd === INITIAL_PASSWORD) throw new Error("新密码不能与初始密码 000000 相同");
  if (pwd === SUPERADMIN_PASSWORD && profile.role === "superadmin") {
    throw new Error("新密码不能与当前密码相同");
  }

  if (profile.mustChangePassword === true) {
    u.set("password", pwd);
    u.set("mustChangePassword", false);
    await u.save();
  } else {
    if (!oldPassword) throw new Error("请输入原密码");
    await u.updatePassword(oldPassword, pwd);
  }
}

/** 一次性初始化固定超级管理员 Admin / chaojiguanliyuan */
export async function bootstrapSuperAdmin() {
  const q = new AV.Query("config");
  q.equalTo("name", "bootstrap");
  const boot = await q.first();
  if (boot) throw new Error("ALREADY_BOOTSTRAPPED");

  const username = "ADMIN";
  let user;
  try {
    user = new AV.User();
    user.set("username", username);
    user.set("password", SUPERADMIN_PASSWORD);
    user.set("employeeId", "Admin");
    user.set("key", "ADMIN");
    user.set("dept", "人力资源部");
    user.set("role", "superadmin");
    user.set("gen", null);
    user.set("active", true);
    user.set("mustChangePassword", false);
    user.set("protected", true);
    await user.signUp();
  } catch (e) {
    // 用户名被占用：尝试直接登录（上次初始化半途中断）
    if (e.code === 202 || /taken|exists/i.test(e.message || "")) {
      await AV.User.logIn(username, SUPERADMIN_PASSWORD);
      user = AV.User.current();
    } else {
      throw e;
    }
  }

  // loginIndex
  const iq = new AV.Query("loginIndex");
  iq.equalTo("key", "ADMIN");
  let idx = await iq.first();
  if (!idx) {
    idx = new AV.Object("loginIndex");
    idx.set("key", "ADMIN");
  }
  idx.set("username", username);
  idx.set("uid", user.id);
  idx.set("active", true);
  await idx.save();

  // bootstrap 标记
  const cfg = new AV.Object("config");
  cfg.set("name", "bootstrap");
  cfg.set("done", true);
  cfg.set("by", user.id);
  await cfg.save();
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
    await AV.User.logOut();
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
  const code = e && (e.code != null ? String(e.code) : (e.message || ""));
  const msg = e && e.message ? String(e.message) : "";
  const map = {
    "200": "服务器异常，请稍后再试",
    "201": "密码不能为空",
    "202": "该员工号已存在账号（如忘记密码请使用「重置密码」）",
    "210": "员工号或密码错误",
    "211": "员工号或密码错误",
    "213": "账号不存在",
    "216": "登录已过期，请重新登录",
    "219": "登录尝试次数过多，请稍后再试",
    "107": "网络异常，请检查网络后重试",
    ALREADY_BOOTSTRAPPED: "系统已初始化，无需重复操作",
  };
  if (map[code]) return map[code];
  if (/password/i.test(msg) && /length/i.test(msg)) return "密码至少 6 位";
  if (/Could not find user/i.test(msg)) return "员工号或密码错误";
  if (/network|timeout|failed to fetch/i.test(msg)) return "网络异常，请检查网络后重试";
  return msg || "操作失败，请重试";
}
