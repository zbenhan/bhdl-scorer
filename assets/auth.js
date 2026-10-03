// 鉴权与账号管理（登录页、改密页、后台共用）
import { auth, db } from "./firebase.js";
import {
  signInAnonymously,
  signInWithEmailAndPassword,
  signOut,
  updatePassword,
  reauthenticateWithCredential,
  EmailAuthProvider,
} from "firebase/auth";
import {
  doc,
  getDoc,
  setDoc,
  updateDoc,
  writeBatch,
  serverTimestamp,
} from "firebase/firestore";

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

/** 代次登录邮箱：员工号.代次码@scorer.local（非字母数字字符替换为 _） */
function emailFor(key, gen) {
  const safe = key.replace(/[^A-Z0-9]/g, "_");
  return `${safe}.${gen}@${EMAIL_DOMAIN}`;
}

/** 等待 Auth 状态首次返回 */
export function waitAuth() {
  return new Promise((resolve) => {
    const unsub = auth.onAuthStateChanged((u) => {
      unsub();
      resolve(u);
    });
  });
}

/** 未登录时先建立匿名会话（用于读取 loginIndex） */
export async function ensureAnon() {
  if (auth.currentUser) return auth.currentUser;
  await signInAnonymously(auth);
  return auth.currentUser;
}

/**
 * 调用 Firebase Auth REST 新建账号（不会顶掉管理员当前的 SDK 登录态）
 * 返回 { localId, email }
 */
async function restSignUp(email, password) {
  const url = `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${window.FIREBASE_CONFIG.apiKey}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  });
  const json = await res.json();
  if (!res.ok || json.error) {
    throw new Error(json.error ? json.error.message : "SIGNUP_FAILED");
  }
  return { localId: json.localId, email: json.email };
}

/** 员工号 + 密码登录（自动解析当前代次邮箱） */
export async function loginWithEmployeeId(rawId, password) {
  const key = normId(rawId);
  if (!key) throw new Error("请输入员工号");
  if (!password) throw new Error("请输入密码");

  await ensureAnon();
  const idxSnap = await getDoc(doc(db, "loginIndex", key));
  if (!idxSnap.exists()) {
    // 不暴露员工号是否存在
    throw new Error("员工号或密码错误");
  }
  const { email } = idxSnap.data();
  await signInWithEmailAndPassword(auth, email, password);
}

/** 读取当前登录用户档案；匿名/无档案返回 null */
export async function getCurrentProfile() {
  const u = auth.currentUser;
  if (!u || u.isAnonymous) return null;
  const snap = await getDoc(doc(db, "users", u.uid));
  if (!snap.exists()) return null;
  return { id: snap.id, ...snap.data() };
}

export function isManagerProfile(p) {
  return p && (p.role === "admin" || p.role === "superadmin");
}

/** 各角色登录后的首页 */
export function homePath(role) {
  return role === "scorer" ? "score.html" : "admin.html";
}

/**
 * 页面守卫：要求已登录的真实账号。
 * 返回 profile；未登录跳首页；待改密跳改密页；停用则退出并跳首页。
 */
export async function requireProfile({ requireChanged = true } = {}) {
  if (!auth.currentUser) await waitAuth();
  const p = await getCurrentProfile();
  if (!p) {
    location.replace("index.html");
    return null;
  }
  if (p.active === false) {
    await signOut(auth);
    location.replace("index.html?msg=" + encodeURIComponent("账号已停用，请联系管理员"));
    return null;
  }
  if (requireChanged && p.mustChangePassword === true) {
    location.replace("change-password.html");
    return null;
  }
  return p;
}

/**
 * 管理员新建账号（超管可建 admin/leader/scorer，普通管理员只能建 scorer）
 * 初始密码固定 000000，mustChangePassword=true
 * 管理员部门固定为「人力资源部」
 */
export async function managerCreateAccount({ employeeId, dept = "", role }) {
  const displayId = String(employeeId || "").trim();
  const key = normId(displayId);
  if (!key) throw new Error("请输入员工号");
  if (!["admin", "leader", "scorer"].includes(role)) throw new Error("角色非法");
  if (role === "scorer" && !String(dept).trim()) throw new Error("请填写所属部门");
  const finalDept = role === "admin" ? "人力资源部" : String(dept).trim();

  const idxRef = doc(db, "loginIndex", key);
  const exist = await getDoc(idxRef);
  if (exist.exists()) {
    throw new Error("该员工号已存在账号：如已停用可直接启用；如忘记密码请使用「重置密码」");
  }

  const gen = genToken();
  const email = emailFor(key, gen);
  const cred = await restSignUp(email, INITIAL_PASSWORD);

  // 先写 users 档案（规则允许），随后 loginIndex 指向新档案（规则需读到它）
  await setDoc(doc(db, "users", cred.localId), {
    employeeId: displayId,
    key,
    dept: finalDept,
    role,
    gen,
    active: true,
    mustChangePassword: true,
    protected: false,
    createdAt: serverTimestamp(),
    createdBy: auth.currentUser ? auth.currentUser.uid : null,
  });
  await setDoc(idxRef, { email, uid: cred.localId, active: true });
  return { uid: cred.localId, email };
}

/**
 * 上级重置密码：生成新代次账号（密码 000000 + 强制改密），
 * 切换 loginIndex，旧代次档案立即停用。
 * 规则保证：超管可重置管理员/打分人员；普通管理员只能重置打分人员。
 */
export async function managerResetPassword(profile) {
  if (!profile || !profile.key) throw new Error("账号信息缺失");
  if (profile.protected === true) throw new Error("固定超级管理员账号不可重置");

  const key = profile.key;
  const gen = genToken();
  const email = emailFor(key, gen);
  const cred = await restSignUp(email, INITIAL_PASSWORD);

  await setDoc(doc(db, "users", cred.localId), {
    employeeId: profile.employeeId,
    key,
    dept: profile.dept || "",
    role: profile.role,
    gen,
    active: true,
    mustChangePassword: true,
    protected: false,
    resetOf: profile.id,
    createdAt: serverTimestamp(),
    createdBy: auth.currentUser ? auth.currentUser.uid : null,
  });

  const batch = writeBatch(db);
  batch.update(doc(db, "users", profile.id), { active: false });
  batch.set(doc(db, "loginIndex", key), { email, uid: cred.localId, active: true });
  await batch.commit();
  return { uid: cred.localId };
}

/** 管理员停用/启用账号（固定超管除外） */
export async function managerSetActive(profile, active) {
  if (profile.protected === true) throw new Error("固定超级管理员账号不可停用");
  await updateDoc(doc(db, "users", profile.id), { active: !!active });
}

/** 管理员修改打分人员所属部门 */
export async function managerUpdateDept(profile, dept) {
  await updateDoc(doc(db, "users", profile.id), { dept: String(dept || "").trim() });
}

/**
 * 修改本人密码
 * - 首次强制改密：无需旧密码（刚刚登录），新密码不能为 000000
 * - 日常修改：需验证旧密码
 */
export async function changeMyPassword(profile, { oldPassword, newPassword }) {
  const u = auth.currentUser;
  if (!u) throw new Error("未登录");
  const pwd = String(newPassword || "");
  if (pwd.length < 6) throw new Error("新密码至少 6 位");
  if (pwd === INITIAL_PASSWORD) throw new Error("新密码不能与初始密码 000000 相同");
  if (pwd === SUPERADMIN_PASSWORD && profile.role === "superadmin") {
    throw new Error("新密码不能与当前密码相同");
  }

  if (profile.mustChangePassword === true) {
    try {
      await updatePassword(u, pwd);
    } catch (e) {
      // 登录态过期时用初始密码重新认证一次
      if (e && (e.code === "auth/requires-recent-login" || e.code === "auth/invalid-credential")) {
        const c = EmailAuthProvider.credential(u.email, INITIAL_PASSWORD);
        await reauthenticateWithCredential(u, c);
        await updatePassword(u, pwd);
      } else {
        throw e;
      }
    }
    await updateDoc(doc(db, "users", u.uid), { mustChangePassword: false });
  } else {
    if (!oldPassword) throw new Error("请输入原密码");
    const c = EmailAuthProvider.credential(u.email, oldPassword);
    await reauthenticateWithCredential(u, c);
    await updatePassword(u, pwd);
  }
}

/** 一次性初始化固定超级管理员 Admin / chaojiguanliyuan */
export async function bootstrapSuperAdmin() {
  await ensureAnon();
  const bootSnap = await getDoc(doc(db, "config", "bootstrap"));
  if (bootSnap.exists()) throw new Error("ALREADY_BOOTSTRAPPED");

  const email = `ADMIN@${EMAIL_DOMAIN}`;

  try {
    await restSignUp(email, SUPERADMIN_PASSWORD);
  } catch (e) {
    // 上次初始化半途中断、Auth 账号已存在：幂等继续
    if (e.message !== "EMAIL_EXISTS") throw e;
  }

  await signInWithEmailAndPassword(auth, email, SUPERADMIN_PASSWORD);
  const uid = auth.currentUser.uid;

  const userSnap = await getDoc(doc(db, "users", uid));
  if (!userSnap.exists()) {
    await setDoc(doc(db, "users", uid), {
      employeeId: "Admin",
      key: "ADMIN",
      dept: "人力资源部",
      role: "superadmin",
      gen: null,
      active: true,
      mustChangePassword: false,
      protected: true,
      createdAt: serverTimestamp(),
    });
  }

  const idxSnap = await getDoc(doc(db, "loginIndex", "ADMIN"));
  if (!idxSnap.exists()) {
    await setDoc(doc(db, "loginIndex", "ADMIN"), { email, uid, active: true });
  }
  await setDoc(doc(db, "config", "bootstrap"), {
    done: true,
    at: serverTimestamp(),
    by: uid,
  });
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
    await signOut(auth);
    location.replace("index.html");
  });
}

/** HTML 转义，防止部门名等输入中的特殊字符破坏页面 */
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
  const code = e && (e.code || e.message || "");
  const map = {
    "auth/invalid-credential": "员工号或密码错误",
    "auth/wrong-password": "员工号或密码错误",
    "auth/user-not-found": "员工号或密码错误",
    "auth/user-disabled": "账号已停用，请联系管理员",
    "auth/too-many-requests": "登录尝试次数过多，请稍后再试",
    "auth/network-request-failed": "网络异常，请检查网络后重试",
    "auth/requires-recent-login": "登录已过期，请退出后重新登录再操作",
    "auth/operation-not-allowed": "Firebase 未开启对应登录方式，请在控制台启用「电子邮件/密码」和「匿名」登录",
    "auth/weak-password": "密码强度不足，至少 6 位",
    EMAIL_EXISTS: "账号异常（邮箱已存在），请重试或联系开发者",
    OPERATION_NOT_ALLOWED: "Firebase 未开启「电子邮件/密码」登录方式，请在控制台启用",
    WEAK_PASSWORD: "密码强度不足，至少 6 位",
    "permission-denied": "没有操作权限（可能无权管理该类账号，或账号已停用）",
    ALREADY_BOOTSTRAPPED: "系统已初始化，无需重复操作",
  };
  return map[code] || e.message || "操作失败，请重试";
}
