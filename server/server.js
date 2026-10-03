// 管理部门打分系统 - 自建后端（零依赖，Node.js 18+ 直接运行）
// 数据存储：同目录 data.json（备份=复制该文件）
// 启动：node server.js   （建议用 pm2 或 systemd 常驻）
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = parseInt(process.env.PORT || "3000", 10);
// 与前端 assets/lc-config.js 里的 restKey 必须一致；务必改成随机长字符串
const API_SECRET = process.env.API_SECRET || "PLEASE_CHANGE_ME_TO_A_LONG_RANDOM_STRING";
const DATA_FILE = path.join(__dirname, "data.json");

// ---------------- 数据层 ----------------
let db = { users: [], sessions: {}, classes: {} };
try {
  db = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
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

// ---------------- 工具 ----------------
function send(res, code, obj, origin) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type,X-Bmob-Application-Id,X-Bmob-REST-API-Key,X-Bmob-Session-Token",
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

function publicUser(u, token) {
  const o = {
    objectId: u.objectId,
    username: u.username,
    createdAt: u.createdAt,
    updatedAt: u.updatedAt,
  };
  if (token) o.sessionToken = token;
  return o;
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
  return list.sort((a, b) => {
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

  // API 密钥校验
  if (req.headers["x-bmob-rest-api-key"] !== API_SECRET) {
    return send(res, 401, { code: 401, error: "unauthorized" }, origin);
  }

  try {
    // ---- 用户注册（管理员代建，不影响调用方会话）----
    if (req.method === "POST" && p === "/1/users") {
      const body = await readBody(req);
      const { username, password } = body;
      if (!username || !password) return send(res, 400, { code: 107, error: "username/password required" }, origin);
      if (String(password).length < 6) return send(res, 400, { code: 107, error: "password at least 6 chars" }, origin);
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
      return send(res, 201, { objectId: user.objectId, createdAt: user.createdAt, sessionToken: "" }, origin);
    }

    // ---- 登录 ----
    if (req.method === "GET" && p === "/1/login") {
      const username = u.searchParams.get("username") || "";
      const password = u.searchParams.get("password") || "";
      const user = db.users.find((x) => x.username === username);
      if (!user || user.pwd !== hashPwd(password, user.salt)) {
        return send(res, 400, { code: 101, error: "username or password incorrect." }, origin);
      }
      const token = newToken();
      db.sessions[token] = user.objectId;
      save();
      return send(res, 200, publicUser(user, token), origin);
    }

    // ---- 修改本人密码 ----
    const mUser = p.match(/^\/1\/users\/([a-z0-9]+)$/);
    if (req.method === "PUT" && mUser) {
      const token = req.headers["x-bmob-session-token"];
      const uid = db.sessions[token];
      if (!uid || uid !== mUser[1]) {
        return send(res, 400, { code: 206, error: "session token invalid" }, origin);
      }
      const user = db.users.find((x) => x.objectId === uid);
      if (!user) return send(res, 404, { code: 101, error: "user not found" }, origin);
      const body = await readBody(req);
      const oldPwd = body.old_password;
      const newPwd = body.new_password;
      if (user.pwd !== hashPwd(oldPwd || "", user.salt)) {
        return send(res, 400, { code: 101, error: "old password incorrect" }, origin);
      }
      if (!newPwd || String(newPwd).length < 6) {
        return send(res, 400, { code: 107, error: "password at least 6 chars" }, origin);
      }
      user.salt = newId();
      user.pwd = hashPwd(newPwd, user.salt);
      user.updatedAt = now();
      // 改密后使旧会话全部失效
      for (const t of Object.keys(db.sessions)) {
        if (db.sessions[t] === uid) delete db.sessions[t];
      }
      save();
      return send(res, 200, { updatedAt: user.updatedAt }, origin);
    }

    // ---- 通用数据表 ----
    const mCls = p.match(/^\/1\/classes\/([A-Za-z0-9_]+)(?:\/([a-z0-9]+))?$/);
    if (mCls) {
      const table = mCls[1];
      const oid = mCls[2];
      if (!db.classes[table]) db.classes[table] = [];
      const rows = db.classes[table];

      if (req.method === "GET" && !oid) {
        let cond = {};
        try {
          cond = JSON.parse(u.searchParams.get("where") || "{}");
        } catch {}
        let list = rows.filter((r) => matchWhere(r, cond));
        const wantCount = u.searchParams.get("count") === "1";
        const limit = parseInt(u.searchParams.get("limit") || "100", 10);
        const skip = parseInt(u.searchParams.get("skip") || "0", 10);
        if (wantCount) return send(res, 200, { count: list.length, results: [] }, origin);
        list = applyOrder(list, u.searchParams.get("order"));
        return send(res, 200, { results: list.slice(skip, skip + limit) }, origin);
      }

      if (req.method === "POST" && !oid) {
        const body = await readBody(req);
        const row = { ...body, objectId: newId() + newId(), createdAt: now(), updatedAt: now() };
        rows.push(row);
        save();
        return send(res, 201, { objectId: row.objectId, createdAt: row.createdAt }, origin);
      }

      const row = rows.find((r) => r.objectId === oid);
      if (!row) return send(res, 404, { code: 101, error: "object not found" }, origin);

      if (req.method === "PUT" && oid) {
        const body = await readBody(req);
        Object.assign(row, body);
        row.objectId = oid;
        row.updatedAt = now();
        save();
        return send(res, 200, { updatedAt: row.updatedAt }, origin);
      }

      if (req.method === "DELETE" && oid) {
        db.classes[table] = rows.filter((r) => r.objectId !== oid);
        save();
        return send(res, 200, { msg: "ok" }, origin);
      }
    }

    return send(res, 404, { code: 404, error: "not found" }, origin);
  } catch (e) {
    return send(res, 500, { code: 500, error: String(e && e.message || e) }, origin);
  }
});

server.listen(PORT, () => {
  console.log(`打分系统后端已启动: http://0.0.0.0:${PORT}`);
  console.log(`数据文件: ${DATA_FILE}`);
  if (API_SECRET === "PLEASE_CHANGE_ME_TO_A_LONG_RANDOM_STRING") {
    console.log("警告：请设置 API_SECRET 环境变量为随机长字符串！");
  }
});
