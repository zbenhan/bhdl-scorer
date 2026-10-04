// 管理部门打分系统 - 自建后端（零依赖，Node.js 18+ 直接运行）
// 数据存储：同目录 data.json（备份=复制该文件）
// 启动：node server.js   （建议用 pm2 或 systemd 常驻）
//
// 安全模型：无全局密钥。登录后发放 sessionToken（通行证），之后所有请求凭通行证。
// 权限规则：
//   - 登录接口、loginIndex/config 表查询：公开（登录页与初始化页需要）
//   - 建账号：仅管理员（系统无任何账号时的首个账号除外，即初始化）
//   - 数据表查询：需登录；profiles 仅本人或管理员；scores 打分人员仅本人
//   - 数据表写入：rounds/departments/config/loginIndex 仅管理员；
//     profiles 仅管理员（本人可改 mustChangePassword 字段）；
//     scores 任何登录用户可创建（员工号强制为本人），修改/删除仅管理员
//   - 角色提升（创建/修改 admin、superadmin 档案）：仅超级管理员
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = parseInt(process.env.PORT || "3000", 10);
const DATA_FILE = path.join(__dirname, "data.json");

// ---------------- 数据层 ----------------
let db = { users: [], sessions: {}, classes: {} };
try {
  db = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  db.sessions = db.sessions || {};
  db.classes = db.classes || {};
  db.users = db.users || [];
} catch {}
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 1));
  }, 200);
}

function newId() {
  return crypto.randomBytes(6).toString("hex");
}
function now() {
  return new Date().toISOString();
}
function hashPwd(pwd, salt) {
  return crypto.createHash("sha256").update(salt + ":" + pwd).digest("hex");
}
function newToken() {
  return crypto.randomBytes(24).toString("hex");
}

// ---------------- 权限辅助 ----------------
function table(name) {
  if (!db.classes[name]) db.classes[name] = [];
  return db.classes[name];
}
function sessionUid(req) {
  return db.sessions[req.headers["x-session-token"]] || null;
}
function callerProfile(req) {
  const uid = sessionUid(req);
  if (!uid) return null;
  const mine = table("profiles").filter((r) => r.uid === uid && r.active === true);
  if (!mine.length) return null;
  mine.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  return mine[mine.length - 1];
}
const isManager = (p) => p && (p.role === "superadmin" || p.role === "admin");
const isSuper = (p) => p && p.role === "superadmin";
const bootstrapEmpty = () => table("profiles").length === 0;

// ---------------- 工具 ----------------
function send(res, code, obj, origin) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,X-Session-Token",
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 1e6) req.destroy();
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(new Error("bad json"));
      }
    });
    req.on("error", reject);
  });
}

function matchWhere(row, cond) {
  for (const k of Object.keys(cond || {})) {
    const v = cond[k];
    if (v && typeof v === "object" && v.$in) {
      if (!v.$in.includes(row[k])) return false;
    } else if (row[k] !== v) {
      return false;
    }
  }
  return true;
}

function applyOrder(list, order) {
  if (!order) return list;
  const keys = String(order).split(",");
  return list.slice().sort((a, b) => {
    for (let key of keys) {
      const desc = key.startsWith("-");
      const f = desc ? key.slice(1) : key;
      const av = a[f] == null ? "" : a[f];
      const bv = b[f] == null ? "" : b[f];
      if (av < bv) return desc ? 1 : -1;
      if (av > bv) return desc ? -1 : 1;
    }
    return 0;
  });
}

// ---------------- 路由 ----------------
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  const p = u.pathname;
  const origin = req.headers.origin;

  if (req.method === "OPTIONS") return send(res, 204, {}, origin);

  try {
    // ---- 登录（公开）----
    if ((req.method === "POST" || req.method === "GET") && p === "/1/login") {
      const src = req.method === "POST" ? await readBody(req) : Object.fromEntries(u.searchParams);
      const user = db.users.find((x) => x.username === (src.username || ""));
      if (!user || user.pwd !== hashPwd(src.password || "", user.salt)) {
        return send(res, 400, { code: 101, error: "username or password incorrect." }, origin);
      }
      const token = newToken();
      db.sessions[token] = user.objectId;
      save();
      return send(res, 200, {
        objectId: user.objectId,
        username: user.username,
        createdAt: user.createdAt,
        sessionToken: token,
      }, origin);
    }

    // ---- 建账号：仅管理员；系统无账号时放开（初始化）----
    if (req.method === "POST" && p === "/1/users") {
      const body = await readBody(req);
      const { username, password } = body;
      if (!username || !password) return send(res, 400, { code: 107, error: "username/password required" }, origin);
      if (String(password).length < 6) return send(res, 400, { code: 107, error: "password at least 6 chars" }, origin);

      if (db.users.length > 0) {
        const prof = callerProfile(req);
        if (!isManager(prof)) return send(res, 403, { code: 403, error: "forbidden" }, origin);
      }
      if (db.users.some((x) => x.username === username)) {
        return send(res, 400, { code: 202, error: "username already taken" }, origin);
      }
      const salt = newId();
      const user = {
        objectId: newId() + newId(),
        username,
        salt,
        pwd: hashPwd(password, salt),
        createdAt: now(),
        updatedAt: now(),
      };
      db.users.push(user);
      save();
      return send(res, 201, { objectId: user.objectId, createdAt: user.createdAt }, origin);
    }

    // ---- 修改本人密码 ----
    const mUser = p.match(/^\/1\/users\/([a-z0-9]+)$/);
    if (req.method === "PUT" && mUser) {
      const uid = sessionUid(req);
      if (!uid || uid !== mUser[1]) {
        return send(res, 400, { code: 206, error: "session token invalid" }, origin);
      }
      const user = db.users.find((x) => x.objectId === uid);
      if (!user) return send(res, 404, { code: 101, error: "user not found" }, origin);
      const body = await readBody(req);
      if (user.pwd !== hashPwd(body.old_password || "", user.salt)) {
        return send(res, 400, { code: 101, error: "old password incorrect" }, origin);
      }
      if (!body.new_password || String(body.new_password).length < 6) {
        return send(res, 400, { code: 107, error: "password at least 6 chars" }, origin);
      }
      user.salt = newId();
      user.pwd = hashPwd(body.new_password, user.salt);
      user.updatedAt = now();
      for (const t of Object.keys(db.sessions)) {
        if (db.sessions[t] === uid) delete db.sessions[t];
      }
      save();
      return send(res, 200, { updatedAt: user.updatedAt }, origin);
    }

    // ---- 通用数据表 ----
    const mCls = p.match(/^\/1\/classes\/([A-Za-z0-9_]+)(?:\/([a-z0-9]+))?$/);
    if (mCls) {
      const tname = mCls[1];
      const oid = mCls[2];
      const rows = table(tname);
      const prof = callerProfile(req);
      const uid = sessionUid(req);

      // 查询
      if (req.method === "GET" && !oid) {
        let cond = {};
        try {
          cond = JSON.parse(u.searchParams.get("where") || "{}");
        } catch {}
        // 公开表：登录页查 loginIndex、初始化页查 config
        const publicTable = tname === "loginIndex" || tname === "config";
        if (!publicTable) {
          // 初始化期（profiles 为空）允许已登录会话查询
          if (!prof && !(bootstrapEmpty() && uid)) {
            return send(res, 403, { code: 403, error: "forbidden" }, origin);
          }
          if (tname === "profiles" && prof && !isManager(prof) && cond.uid !== uid) {
            return send(res, 403, { code: 403, error: "forbidden" }, origin);
          }
          if (tname === "scores" && prof && prof.role === "scorer" && cond.key !== prof.key) {
            return send(res, 403, { code: 403, error: "forbidden" }, origin);
          }
        }
        let list = rows.filter((r) => matchWhere(r, cond));
        if (u.searchParams.get("count") === "1") {
          return send(res, 200, { count: list.length, results: [] }, origin);
        }
        const limit = parseInt(u.searchParams.get("limit") || "100", 10);
        const skip = parseInt(u.searchParams.get("skip") || "0", 10);
        list = applyOrder(list, u.searchParams.get("order"));
        return send(res, 200, { results: list.slice(skip, skip + limit) }, origin);
      }

      // 写入均需登录；初始化期（profiles 为空）允许已登录会话写入
      const boot = bootstrapEmpty();
      if (!prof && !(boot && uid)) {
        return send(res, 403, { code: 403, error: "forbidden" }, origin);
      }

      // 新建
      if (req.method === "POST" && !oid) {
        const body = await readBody(req);
        if (tname === "scores") {
          if (!prof) return send(res, 403, { code: 403, error: "forbidden" }, origin);
          // 员工号强制为本人，防伪造
          body.key = prof.key;
          body.employeeId = prof.employeeId;
        } else if (!boot) {
          if (!isManager(prof)) return send(res, 403, { code: 403, error: "forbidden" }, origin);
          if (tname === "profiles" && ["admin", "superadmin"].includes(body.role) && !isSuper(prof)) {
            return send(res, 403, { code: 403, error: "forbidden" }, origin);
          }
        }
        const row = { ...body, objectId: newId() + newId(), createdAt: now(), updatedAt: now() };
        rows.push(row);
        save();
        return send(res, 201, { objectId: row.objectId, createdAt: row.createdAt }, origin);
      }

      const row = rows.find((r) => r.objectId === oid);
      if (!row) return send(res, 404, { code: 101, error: "object not found" }, origin);

      if (req.method === "PUT" && oid) {
        const body = await readBody(req);
        // 本人仅可把 mustChangePassword 置为 false（首次改密流程）
        const ownFlagOnly =
          tname === "profiles" &&
          row.uid === uid &&
          Object.keys(body).every((k) => k === "mustChangePassword");
        if (!ownFlagOnly && !bootstrapEmpty()) {
          if (!isManager(prof)) return send(res, 403, { code: 403, error: "forbidden" }, origin);
          if (tname === "profiles") {
            const role = body.role != null ? body.role : row.role;
            if (["admin", "superadmin"].includes(role) && !isSuper(prof)) {
              return send(res, 403, { code: 403, error: "forbidden" }, origin);
            }
          }
          if (tname === "scores" && !isManager(prof)) {
            return send(res, 403, { code: 403, error: "forbidden" }, origin);
          }
        }
        Object.assign(row, body);
        row.objectId = oid;
        row.updatedAt = now();
        save();
        return send(res, 200, { updatedAt: row.updatedAt }, origin);
      }

      if (req.method === "DELETE" && oid) {
        if (!isManager(prof)) return send(res, 403, { code: 403, error: "forbidden" }, origin);
        db.classes[tname] = rows.filter((r) => r.objectId !== oid);
        save();
        return send(res, 200, { msg: "ok" }, origin);
      }
    }

    return send(res, 404, { code: 404, error: "not found" }, origin);
  } catch (e) {
    return send(res, 500, { code: 500, error: String((e && e.message) || e) }, origin);
  }
});

server.listen(PORT, () => {
  console.log(`打分系统后端已启动: http://0.0.0.0:${PORT}`);
  console.log(`数据文件: ${DATA_FILE}`);
});
