// 后端权限模型完整测试
const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs");

try { fs.unlinkSync("server/data.json"); } catch {}

const srv = spawn("node", ["server/server.js"], {
  env: { ...process.env, PORT: "13001" },
});

let token = null;
function req(method, path, body, useToken = true) {
  return new Promise((resolve, reject) => {
    const o = new URL(path, "http://127.0.0.1:13001");
    const opts = { method, hostname: "127.0.0.1", port: 13001, path: o.pathname + o.search, headers: {} };
    if (body) opts.headers["Content-Type"] = "application/json";
    if (useToken && token) opts.headers["X-Session-Token"] = token;
    const r = http.request(opts, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => resolve({ status: res.statusCode, body: d ? JSON.parse(d) : null }));
    });
    r.on("error", reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}
const where = (o) => "where=" + encodeURIComponent(JSON.stringify(o));
let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log("  PASS", name); }
  else { fail++; console.log("  FAIL", name); }
}

(async () => {
  await new Promise((r) => setTimeout(r, 500));

  console.log("[1] 初始化前");
  let r = await req("GET", "/1/classes/config?" + where({ name: "bootstrap" }), null, false);
  check("config 公开可查", r.status === 200 && r.body.results.length === 0);
  r = await req("GET", "/1/classes/rounds", null, false);
  check("rounds 未登录不可查", r.status === 403);
  r = await req("POST", "/1/users", { username: "HACK", password: "123456" }, false);
  check("无账号时可建首个账号（初始化放开）", r.status === 201);

  console.log("[2] 首个账号登录");
  r = await req("POST", "/1/login", { username: "HACK", password: "123456" }, false);
  token = r.body.sessionToken;
  check("首个账号可登录", r.status === 200);

  console.log("[3] 重建干净环境做正式流程");
  srv.kill();
  await new Promise((r2) => setTimeout(r2, 300));
  try { fs.unlinkSync("server/data.json"); } catch {}
  const srv2 = spawn("node", ["server/server.js"], { env: { ...process.env, PORT: "13001" } });
  await new Promise((r2) => setTimeout(r2, 500));
  token = null;

  // bootstrapSuperAdmin 流程
  r = await req("POST", "/1/users", { username: "ADMIN", password: "chaojiguanliyuan" }, false);
  check("初始化建 ADMIN", r.status === 201);
  const adminId = r.body.objectId;
  r = await req("POST", "/1/login", { username: "ADMIN", password: "chaojiguanliyuan" }, false);
  token = r.body.sessionToken;
  r = await req("GET", "/1/classes/profiles?" + where({ uid: adminId }));
  check("初始化期可查空 profiles", r.status === 200 && r.body.results.length === 0);
  r = await req("POST", "/1/classes/profiles", { uid: adminId, employeeId: "Admin", key: "ADMIN", dept: "人力资源部", role: "superadmin", active: true, mustChangePassword: false, protected: true });
  check("写超管档案", r.status === 201);
  r = await req("POST", "/1/classes/loginIndex", { key: "ADMIN", username: "ADMIN", uid: adminId, active: true });
  check("写 loginIndex", r.status === 201);
  r = await req("POST", "/1/classes/config", { name: "bootstrap", done: true, by: adminId });
  check("写 bootstrap 标记", r.status === 201);

  console.log("[4] 超管建打分人员");
  r = await req("POST", "/1/users", { username: "S001.abc123", password: "000000" });
  const scorerUid = r.body.objectId;
  check("超管可建号", r.status === 201);
  r = await req("POST", "/1/classes/profiles", { uid: scorerUid, employeeId: "S001", key: "S001", dept: "科技部", role: "scorer", active: true, mustChangePassword: true });
  check("超管可建 scorer 档案", r.status === 201);
  r = await req("POST", "/1/classes/profiles", { uid: "x", employeeId: "X", key: "X", role: "admin", active: true });
  check("超管可建 admin 档案", r.status === 201);

  console.log("[5] 打分人员权限");
  r = await req("POST", "/1/login", { username: "S001.abc123", password: "000000" }, false);
  token = r.body.sessionToken;
  const scorerToken = token;
  check("打分人员登录", r.status === 200);
  r = await req("GET", "/1/classes/profiles?" + where({ uid: scorerUid }));
  check("可查自己档案", r.status === 200 && r.body.results.length === 1);
  r = await req("GET", "/1/classes/profiles?" + where({ role: "admin" }));
  check("不可查他人档案", r.status === 403);
  r = await req("POST", "/1/users", { username: "HACK2", password: "123456" });
  check("不可建账号", r.status === 403);
  r = await req("POST", "/1/classes/rounds", { name: "黑客期次", status: "active" });
  check("不可建期次", r.status === 403);
  r = await req("POST", "/1/classes/scores", { round: "r1", key: "OTHER", employeeId: "OTHER", dept: "x", ratings: {} });
  check("可提交打分", r.status === 201);
  const scoreId = r.body.objectId;
  // 验证 key 被强制为本人
  r = await req("GET", "/1/classes/scores?" + where({ key: "S001" }));
  check("打分行 key 强制为本人", r.status === 200 && r.body.results[0] && r.body.results[0].key === "S001");
  r = await req("GET", "/1/classes/scores?" + where({ key: "OTHER" }));
  check("不可查他人打分", r.status === 403);
  r = await req("PUT", "/1/classes/scores/" + scoreId, { dept: "改" });
  check("不可改打分", r.status === 403);
  // 本人改 mustChangePassword
  const myProf = (await req("GET", "/1/classes/profiles?" + where({ uid: scorerUid }))).body.results[0];
  r = await req("PUT", "/1/classes/profiles/" + myProf.objectId, { mustChangePassword: false });
  check("本人可改 mustChangePassword", r.status === 200);
  r = await req("PUT", "/1/classes/profiles/" + myProf.objectId, { active: false });
  check("本人不可停用自己", r.status === 403);

  console.log("[6] 改密码");
  r = await req("PUT", "/1/users/" + scorerUid, { old_password: "000000", new_password: "newpass123" });
  check("本人改密", r.status === 200);
  r = await req("GET", "/1/classes/rounds");
  check("改密后旧通行证失效", r.status === 403);
  r = await req("POST", "/1/login", { username: "S001.abc123", password: "newpass123" }, false);
  check("新密码可登录", r.status === 200);
  token = scorerToken; // 已失效，仅恢复变量

  console.log("[7] 普通管理员不能越权");
  r = await req("POST", "/1/login", { username: "ADMIN", password: "chaojiguanliyuan" }, false);
  token = r.body.sessionToken;
  r = await req("POST", "/1/users", { username: "A001.xyz", password: "000000" });
  const aUid = r.body.objectId;
  r = await req("POST", "/1/classes/profiles", { uid: aUid, employeeId: "A001", key: "A001", dept: "人力资源部", role: "admin", active: true, mustChangePassword: true });
  check("超管建 admin", r.status === 201);
  r = await req("POST", "/1/login", { username: "A001.xyz", password: "000000" }, false);
  token = r.body.sessionToken;
  r = await req("POST", "/1/classes/profiles", { uid: "y1", employeeId: "Y", key: "Y", role: "admin", active: true });
  check("admin 不可建 admin", r.status === 403);
  r = await req("POST", "/1/classes/profiles", { uid: "y2", employeeId: "Y2", key: "Y2", role: "scorer", dept: "x", active: true });
  check("admin 可建 scorer", r.status === 201);
  r = await req("POST", "/1/classes/rounds", { name: "2026-10", status: "active", depts: [] });
  check("admin 可建期次", r.status === 201);

  srv2.kill();
  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
