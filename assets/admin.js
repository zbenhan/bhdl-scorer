// 管理后台全部逻辑
import { db } from "./firebase.js";
import {
  collection,
  doc,
  addDoc,
  getDoc,
  getDocs,
  updateDoc,
  deleteDoc,
  writeBatch,
  query,
  where,
  orderBy,
  serverTimestamp,
} from "firebase/firestore";
import {
  requireProfile,
  renderTopBar,
  escapeHtml,
  zhError,
  managerCreateAccount,
  managerResetPassword,
  managerSetActive,
  managerUpdateDept,
  isManagerProfile,
} from "./auth.js";
import { exportRoundCsv } from "./csv.js";

const profile = await requireProfile();
if (!profile) throw new Error("no profile");
const isSuper = profile.role === "superadmin";
const isLeader = profile.role === "leader";
const isAdminView = profile.role === "admin"; // 管理员：结果匿名、不可下载
if (!isManagerProfile(profile) && !isLeader) {
  location.replace("score.html");
  throw new Error("redirect");
}
renderTopBar(profile, { active: "admin.html" });

// 行领导：只看「结果查看」页签（实名 + 可下载）
if (isLeader) {
  document.querySelectorAll("#tabs button").forEach((b) => {
    if (b.dataset.tab !== "results") b.hidden = true;
  });
  document.querySelector(".page-title").textContent = "打分结果";
  document.querySelector(".page-sub").textContent =
    "实名查看并下载各期次打分结果。";
} else {
  if (isSuper) document.getElementById("tabBtnAdmins").hidden = false;
  // 普通管理员：结果匿名、不提供下载
  if (isAdminView) {
    document.getElementById("btnDownloadCsv").hidden = true;
  }
}

// ---------------- 通用工具 ----------------
function fmt(ts) {
  if (!ts) return "";
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(
    d.getHours()
  )}:${p(d.getMinutes())}`;
}

/** 稳定字符串哈希（匿名视图的行排序用） */
function hashKey(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h;
}

function showAlert(name, type, msg) {
  const el = document.getElementById("alert" + name);
  el.className = "alert " + type;
  el.textContent = msg;
  el.hidden = false;
}
function hideAlert(name) {
  document.getElementById("alert" + name).hidden = true;
}

/** 同一员工号多个代次时，取当前生效档案：优先启用态，其次创建时间最新 */
function pushCurrent(map, p) {
  const prev = map.get(p.key);
  if (!prev) {
    map.set(p.key, p);
    return;
  }
  if (p.active === true && prev.active !== true) {
    map.set(p.key, p);
    return;
  }
  if (!!p.active === !!prev.active) {
    const t1 = (prev.createdAt && prev.createdAt.seconds) || 0;
    const t2 = (p.createdAt && p.createdAt.seconds) || 0;
    if (t2 >= t1) map.set(p.key, p);
  }
}

async function deleteDocsInChunks(docs) {
  for (let i = 0; i < docs.length; i += 400) {
    const b = writeBatch(db);
    docs.slice(i, i + 400).forEach((d) => b.delete(d.ref));
    await b.commit();
  }
}

// ---------------- 选项卡 ----------------
const tabsEl = document.getElementById("tabs");
const loaded = {};
tabsEl.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-tab]");
  if (!btn) return;
  document.querySelectorAll("#tabs button").forEach((b) => b.classList.remove("active"));
  btn.classList.add("active");
  document.querySelectorAll(".tabpanel").forEach((p) => p.classList.remove("active"));
  const name = btn.dataset.tab;
  document.getElementById("panel-" + name).classList.add("active");
  loaders[name]();
});
document.querySelectorAll("[data-reload]").forEach((b) =>
  b.addEventListener("click", () => loaders[b.dataset.reload]())
);

// ---------------- 状态 ----------------
let roundsCache = [];
let activeRound = null;
let resultState = { round: null, rows: [] };

// ===================================================================
// 管理员账号（仅超管）
// ===================================================================
async function loadAdmins() {
  if (!isSuper) return;
  const tbody = document.getElementById("tbodyAdmins");
  tbody.innerHTML = '<tr><td colspan="5" class="loading">加载中…</td></tr>';
  const roleText = { admin: "管理员", leader: "行领导" };
  try {
    const snap = await getDocs(
      query(collection(db, "users"), where("role", "in", ["admin", "leader"]))
    );
    const map = new Map();
    snap.forEach((d) => pushCurrent(map, { id: d.id, ...d.data() }));
    const list = [...map.values()].sort(
      (a, b) => ((a.createdAt && a.createdAt.seconds) || 0) - ((b.createdAt && b.createdAt.seconds) || 0)
    );

    if (!list.length) {
      tbody.innerHTML = '<tr><td colspan="5" class="muted">暂无管理员/行领导账号</td></tr>';
      return;
    }
    tbody.innerHTML = list
      .map(
        (p) => `
      <tr>
        <td>${escapeHtml(p.employeeId)}${p.protected ? ' <span class="badge on">固定</span>' : ""}</td>
        <td><span class="badge role-${escapeHtml(p.role)}">${roleText[p.role] || escapeHtml(p.role)}</span></td>
        <td class="num"><span class="badge ${p.active ? "on" : "off"}">${
          p.active ? "启用" : "停用"
        }</span></td>
        <td>${fmt(p.createdAt)}</td>
        <td>
          <div class="table-actions" data-id="${escapeHtml(p.id)}">
            ${
              p.protected
                ? '<span class="muted">不可操作</span>'
                : `<button class="ghost small" data-action="toggle">${
                    p.active ? "停用" : "启用"
                  }</button>
                   <button class="ghost small danger-text" data-action="resetPwd">重置密码</button>`
            }
          </div>
        </td>
      </tr>`
      )
      .join("");
    tbody._map = map;
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="5">加载失败：${escapeHtml(zhError(e))}</td></tr>`;
  }
}

document.getElementById("formAdminAdd").addEventListener("submit", async (e) => {
  e.preventDefault();
  hideAlert("Admins");
  const input = document.getElementById("adminEmployeeId");
  const roleSel = document.getElementById("adminRole");
  const employeeId = input.value.trim();
  const role = roleSel.value;
  const roleText = role === "leader" ? "行领导" : "管理员";
  try {
    await managerCreateAccount({ employeeId, role });
    showAlert("Admins", "ok", `${roleText} ${employeeId} 已添加，初始密码 000000`);
    input.value = "";
    loadAdmins();
  } catch (err) {
    showAlert("Admins", "error", zhError(err));
  }
});

document.getElementById("tbodyAdmins").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-action]");
  if (!btn) return;
  const box = btn.closest(".table-actions");
  const map = document.getElementById("tbodyAdmins")._map;
  const prof = findProfile(map, box.dataset.id);
  if (!prof) return;
  try {
    if (btn.dataset.action === "toggle") {
      if (!prof.active || confirm(`确定停用 ${prof.employeeId} 吗？停用后将立即无法登录。`)) {
        await managerSetActive(prof, !prof.active);
        loadAdmins();
      }
    } else if (btn.dataset.action === "resetPwd") {
      if (
        confirm(
          `确定将 ${prof.employeeId} 的密码重置为 000000 吗？\n对方下次登录时需要重新设置新密码。`
        )
      ) {
        await managerResetPassword(prof);
        showAlert("Admins", "ok", `已将 ${prof.employeeId} 的密码重置为 000000`);
        loadAdmins();
      }
    }
  } catch (err) {
    showAlert("Admins", "error", zhError(err));
  }
});

function findProfile(map, id) {
  if (!map) return null;
  for (const v of map.values()) if (v.id === id) return v;
  return null;
}

// ===================================================================
// 期次管理
// ===================================================================
async function loadRounds() {
  const tbody = document.getElementById("tbodyRounds");
  tbody.innerHTML = '<tr><td colspan="6" class="loading">加载中…</td></tr>';
  try {
    const snap = await getDocs(query(collection(db, "rounds"), orderBy("createdAt", "desc")));
    const rounds = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

    // 每期提交人数
    await Promise.all(
      rounds.map(async (r) => {
        const s = await getDocs(collection(db, "rounds", r.id, "scores"));
        r.scoreCount = s.size;
      })
    );

    roundsCache = rounds;
    activeRound = rounds.find((r) => r.status === "active") || null;
    populateResultSelector();

    if (!rounds.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="muted">还没有期次，请先创建</td></tr>';
      return;
    }
    tbody.innerHTML = rounds
      .map(
        (r) => `
      <tr>
        <td>${escapeHtml(r.name)}</td>
        <td class="num"><span class="badge ${r.status}">${
          r.status === "active" ? "进行中" : "已关闭"
        }</span></td>
        <td class="num">${(r.depts || []).length}</td>
        <td class="num">${r.scoreCount}</td>
        <td>${fmt(r.createdAt)}</td>
        <td><div class="table-actions">
          ${
            r.status === "active"
              ? '<button class="ghost small" data-action="close">关闭期次</button>'
              : '<button class="ghost small" data-action="reopen">重新开启</button>'
          }
          <button class="ghost small" data-action="view">查看结果</button>
          ${isAdminView ? "" : '<button class="ghost small" data-action="csv">下载CSV</button>'}
          <button class="ghost small danger-text" data-action="clear" ${
            r.scoreCount === 0 ? "disabled" : ""
          }>清空打分</button>
          <button class="ghost small danger-text" data-action="delete" ${
            r.scoreCount > 0 ? "disabled" : ""
          }>删除期次</button>
        </div></td>
      </tr>`
      )
      .join("");

    bindRoundActions(tbody, rounds);
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="6">加载失败：${escapeHtml(zhError(e))}</td></tr>`;
  }
}

function bindRoundActions(tbody, rounds) {
  tbody.querySelectorAll("button[data-action]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const tr = btn.closest("tr");
      const idx = [...tbody.querySelectorAll("tr")].indexOf(tr);
      const r = rounds[idx];
      const action = btn.dataset.action;
      try {
        if (action === "close") {
          if (confirm(`确定关闭期次「${r.name}」吗？关闭后打分人员将无法提交。`)) {
            await updateDoc(doc(db, "rounds", r.id), { status: "closed" });
            loadRounds();
          }
        } else if (action === "reopen") {
          const anyActive = rounds.some((x) => x.status === "active");
          if (anyActive) {
            showAlert("Rounds", "error", "已有进行中的期次，请先关闭后再开启本期");
            return;
          }
          if (confirm(`确定重新开启期次「${r.name}」吗？`)) {
            await updateDoc(doc(db, "rounds", r.id), { status: "active" });
            loadRounds();
          }
        } else if (action === "view") {
          switchToResults(r.id);
        } else if (action === "csv") {
          const rows = await buildResultRows(r);
          exportRoundCsv(r, rows);
        } else if (action === "clear") {
          if (
            confirm(
              `确定清空期次「${r.name}」的全部 ${r.scoreCount} 份打分吗？\n清空后所有打分人员可重新打分。建议先下载结果存档！`
            )
          ) {
            const s = await getDocs(collection(db, "rounds", r.id, "scores"));
            await deleteDocsInChunks([...s.docs]);
            showAlert("Rounds", "ok", "本期打分已清空");
            loadRounds();
          }
        } else if (action === "delete") {
          if (confirm(`确定删除期次「${r.name}」吗？此操作不可恢复。`)) {
            await deleteDoc(doc(db, "rounds", r.id));
            loadRounds();
          }
        }
      } catch (err) {
        showAlert("Rounds", "error", zhError(err));
      }
    });
  });
}

// 默认期次名：当前年月
(function setDefaultRoundName() {
  const d = new Date();
  document.getElementById("roundName").value =
    `${d.getFullYear()}年${String(d.getMonth() + 1).padStart(2, "0")}月`;
})();

document.getElementById("formRoundAdd").addEventListener("submit", async (e) => {
  e.preventDefault();
  hideAlert("Rounds");
  const nameInput = document.getElementById("roundName");
  const name = nameInput.value.trim();
  try {
    const existActive = (roundsCache.length ? roundsCache : await fetchRoundsLight()).some(
      (r) => r.status === "active"
    );
    if (existActive) {
      showAlert("Rounds", "error", "已有进行中的期次，请先关闭后再创建新期次");
      return;
    }
    const deptSnap = await getDocs(
      query(collection(db, "departments"), orderBy("sortOrder", "asc"))
    );
    const depts = deptSnap.docs
      .filter((d) => d.data().active === true)
      .map((d) => ({ id: d.id, name: d.data().name }));
    if (!depts.length) {
      showAlert("Rounds", "error", "还没有启用的被打分部门，请先在「被打分部门」页签添加");
      return;
    }
    await addDoc(collection(db, "rounds"), {
      name,
      status: "active",
      depts,
      createdAt: serverTimestamp(),
      createdBy: profile.employeeId,
    });
    showAlert("Rounds", "ok", `期次「${name}」已创建并开启`);
    loadRounds();
  } catch (err) {
    showAlert("Rounds", "error", zhError(err));
  }
});

async function fetchRoundsLight() {
  const snap = await getDocs(collection(db, "rounds"));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

// ===================================================================
// 打分人员
// ===================================================================
async function loadScorers() {
  const tbody = document.getElementById("tbodyScorers");
  tbody.innerHTML = '<tr><td colspan="4" class="loading">加载中…</td></tr>';
  try {
    const snap = await getDocs(
      query(collection(db, "users"), where("role", "==", "scorer"))
    );
    const map = new Map();
    snap.forEach((d) => pushCurrent(map, { id: d.id, ...d.data() }));
    const list = [...map.values()].sort((a, b) =>
      String(a.employeeId).localeCompare(String(b.employeeId), "zh-Hans-CN")
    );
    if (!list.length) {
      tbody.innerHTML = '<tr><td colspan="4" class="muted">暂无打分人员</td></tr>';
      return;
    }
    tbody.innerHTML = list
      .map(
        (p) => `
      <tr>
        <td>${escapeHtml(p.employeeId)}</td>
        <td>${escapeHtml(p.dept || "")}</td>
        <td class="num"><span class="badge ${p.active ? "on" : "off"}">${
          p.active ? "启用" : "停用"
        }</span></td>
        <td><div class="table-actions" data-id="${escapeHtml(p.id)}">
          <button class="ghost small" data-action="dept">修改部门</button>
          <button class="ghost small" data-action="toggle">${p.active ? "停用" : "启用"}</button>
          <button class="ghost small danger-text" data-action="resetPwd">重置密码</button>
          <button class="ghost small danger-text" data-action="resetScore" ${
            activeRound ? "" : "disabled"
          }>重置本期打分</button>
        </div></td>
      </tr>`
      )
      .join("");
    tbody._map = map;
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="4">加载失败：${escapeHtml(zhError(e))}</td></tr>`;
  }
}

document.getElementById("formScorerAdd").addEventListener("submit", async (e) => {
  e.preventDefault();
  hideAlert("Scorers");
  const idInput = document.getElementById("scorerEmployeeId");
  const deptInput = document.getElementById("scorerDept");
  try {
    await managerCreateAccount({
      employeeId: idInput.value.trim(),
      dept: deptInput.value.trim(),
      role: "scorer",
    });
    showAlert("Scorers", "ok", `打分人员 ${idInput.value.trim()} 已添加，初始密码 000000`);
    idInput.value = "";
    deptInput.value = "";
    loadScorers();
  } catch (err) {
    showAlert("Scorers", "error", zhError(err));
  }
});

document.getElementById("tbodyScorers").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-action]");
  if (!btn || btn.disabled) return;
  const box = btn.closest(".table-actions");
  const map = document.getElementById("tbodyScorers")._map;
  const p = findProfile(map, box.dataset.id);
  if (!p) return;
  try {
    if (btn.dataset.action === "dept") {
      const v = prompt(`修改 ${p.employeeId} 的所属部门：`, p.dept || "");
      if (v != null && v.trim() !== (p.dept || "")) {
        await managerUpdateDept(p, v.trim());
        loadScorers();
      }
    } else if (btn.dataset.action === "toggle") {
      if (!p.active || confirm(`确定停用打分人员 ${p.employeeId} 吗？停用后将立即无法登录。`)) {
        await managerSetActive(p, !p.active);
        loadScorers();
      }
    } else if (btn.dataset.action === "resetPwd") {
      if (
        confirm(
          `确定将 ${p.employeeId} 的密码重置为 000000 吗？\n对方下次登录时需要重新设置新密码。`
        )
      ) {
        await managerResetPassword(p);
        showAlert("Scorers", "ok", `已将 ${p.employeeId} 的密码重置为 000000`);
        loadScorers();
      }
    } else if (btn.dataset.action === "resetScore") {
      if (!activeRound) {
        showAlert("Scorers", "error", "当前没有进行中的期次");
        return;
      }
      const scoreRef = doc(db, "rounds", activeRound.id, "scores", p.key);
      const snap = await getDoc(scoreRef);
      if (!snap.exists()) {
        showAlert("Scorers", "info", `${p.employeeId} 在本期还未打分，无需重置`);
        return;
      }
      if (confirm(`确定重置 ${p.employeeId} 在「${activeRound.name}」的打分吗？对方可重新打分。`)) {
        await deleteDoc(scoreRef);
        showAlert("Scorers", "ok", `已重置 ${p.employeeId} 的本期打分`);
        loadRounds();
      }
    }
  } catch (err) {
    showAlert("Scorers", "error", zhError(err));
  }
});

// ===================================================================
// 被打分部门
// ===================================================================
async function loadDepts() {
  const tbody = document.getElementById("tbodyDepts");
  tbody.innerHTML = '<tr><td colspan="4" class="loading">加载中…</td></tr>';
  try {
    const snap = await getDocs(query(collection(db, "departments"), orderBy("sortOrder", "asc")));
    const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    if (!list.length) {
      tbody.innerHTML = '<tr><td colspan="4" class="muted">暂无部门</td></tr>';
      return;
    }
    tbody.innerHTML = list
      .map(
        (d, i) => `
      <tr>
        <td class="num">
          <button class="ghost small" data-action="up" ${i === 0 ? "disabled" : ""}>↑</button>
          ${d.sortOrder ?? i + 1}
          <button class="ghost small" data-action="down" ${
            i === list.length - 1 ? "disabled" : ""
          }>↓</button>
        </td>
        <td>${escapeHtml(d.name)}</td>
        <td class="num"><span class="badge ${d.active ? "on" : "off"}">${
          d.active ? "启用" : "停用"
        }</span></td>
        <td><div class="table-actions" data-id="${escapeHtml(d.id)}">
          <button class="ghost small" data-action="rename">改名</button>
          <button class="ghost small" data-action="toggle">${d.active ? "停用" : "启用"}</button>
          <button class="ghost small danger-text" data-action="delete">删除</button>
        </div></td>
      </tr>`
      )
      .join("");
    tbody._list = list;
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="4">加载失败：${escapeHtml(zhError(e))}</td></tr>`;
  }
}

document.getElementById("formDeptAdd").addEventListener("submit", async (e) => {
  e.preventDefault();
  hideAlert("Depts");
  const input = document.getElementById("deptName");
  const name = input.value.trim();
  try {
    const list = document.getElementById("tbodyDepts")._list;
    const nextSort = list && list.length ? Math.max(...list.map((d) => d.sortOrder || 0)) + 1 : 1;
    await addDoc(collection(db, "departments"), {
      name,
      active: true,
      sortOrder: nextSort,
      createdAt: serverTimestamp(),
    });
    input.value = "";
    loadDepts();
  } catch (err) {
    showAlert("Depts", "error", zhError(err));
  }
});

document.getElementById("tbodyDepts").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-action]");
  if (!btn || btn.disabled) return;
  const box = btn.closest(".table-actions");
  const list = document.getElementById("tbodyDepts")._list || [];
  const d = list.find((x) => x.id === box.dataset.id);
  if (!d) return;
  const ref = doc(db, "departments", d.id);
  try {
    if (btn.dataset.action === "rename") {
      const v = prompt("修改部门名称：", d.name);
      if (v != null && v.trim() && v.trim() !== d.name) {
        await updateDoc(ref, { name: v.trim() });
        loadDepts();
      }
    } else if (btn.dataset.action === "toggle") {
      await updateDoc(ref, { active: !d.active });
      loadDepts();
    } else if (btn.dataset.action === "up" || btn.dataset.action === "down") {
      const idx = list.findIndex((x) => x.id === d.id);
      const swap = btn.dataset.action === "up" ? list[idx - 1] : list[idx + 1];
      if (!swap) return;
      const b = writeBatch(db);
      b.update(ref, { sortOrder: swap.sortOrder });
      b.update(doc(db, "departments", swap.id), { sortOrder: d.sortOrder });
      await b.commit();
      loadDepts();
    } else if (btn.dataset.action === "delete") {
      if (
        confirm(
          `确定删除部门「${d.name}」吗？\n历史期次已保存该部门的打分快照，不受影响；未关闭的期次不再包含它。`
        )
      ) {
        await deleteDoc(ref);
        loadDepts();
      }
    }
  } catch (err) {
    showAlert("Depts", "error", zhError(err));
  }
});

// ===================================================================
// 结果查看
// ===================================================================
function populateResultSelector() {
  const sel = document.getElementById("resultRound");
  const prefer =
    (sel.value && roundsCache.find((r) => r.id === sel.value)) ||
    roundsCache.find((r) => r.status === "active") ||
    roundsCache[0];
  sel.innerHTML = roundsCache
    .map(
      (r) =>
        `<option value="${r.id}"${prefer && prefer.id === r.id ? " selected" : ""}>${escapeHtml(
          r.name
        )}（${r.status === "active" ? "进行中" : "已关闭"}）</option>`
    )
    .join("");
}

/** 组装某期的打分行：全部打分人员 + 各自打分（含未提交） */
async function buildResultRows(round) {
  const [scoreSnap, userSnap] = await Promise.all([
    getDocs(collection(db, "rounds", round.id, "scores")),
    getDocs(query(collection(db, "users"), where("role", "==", "scorer"))),
  ]);
  const scoreMap = new Map();
  scoreSnap.forEach((d) => {
    const data = d.data();
    if (!scoreMap.has(data.key)) scoreMap.set(data.key, data);
  });

  const curMap = new Map();
  userSnap.forEach((d) => pushCurrent(curMap, { id: d.id, ...d.data() }));
  const scorers = [...curMap.values()].sort((a, b) =>
    String(a.employeeId).localeCompare(String(b.employeeId), "zh-Hans-CN")
  );

  return scorers.map((p) => {
    const s = scoreMap.get(p.key);
    return {
      employeeId: p.employeeId,
      dept: p.dept || "",
      submitted: !!s,
      ratings: s ? s.ratings : {},
      submittedAt: s ? s.submittedAt : null,
    };
  });
}

async function renderResults(round) {
  const wrap = document.getElementById("resultTableWrap");
  const meta = document.getElementById("resultMeta");
  const table = document.getElementById("resultTable");
  const rows = await buildResultRows(round);
  resultState = { round, rows };

  const depts = round.depts || [];
  const submitted = rows.filter((r) => r.submitted).length;
  meta.textContent =
    `期次「${round.name}」：应打分 ${rows.length} 人，已提交 ${submitted} 人，未提交 ${
      rows.length - submitted
    } 人` + (isAdminView ? "（匿名视图：不显示打分人身份）" : "");

  const avg = depts.map((d) => {
    const vals = rows.map((r) => r.ratings[d.id]).filter((v) => typeof v === "number");
    if (!vals.length) return "";
    return Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 100) / 100;
  });

  // 普通管理员为匿名视图：隐藏员工号/部门列，行序随机化（按 key 哈希排序）
  const viewRows = isAdminView
    ? [...rows].sort((a, b) => hashKey(a.employeeId) - hashKey(b.employeeId))
    : rows;

  table.innerHTML = `
    <thead><tr>
      ${isAdminView ? "<th>打分人员</th>" : "<th>员工号</th><th>所属部门</th>"}
      ${depts.map((d) => `<th class="num">${escapeHtml(d.name)}</th>`).join("")}
      <th>提交情况</th>
    </tr></thead>
    <tbody>
      ${viewRows
        .map(
          (r, i) => `
        <tr class="${r.submitted ? "" : "unsubmitted"}">
          ${
            isAdminView
              ? `<td class="muted">匿名 ${i + 1} 号</td>`
              : `<td>${escapeHtml(r.employeeId)}</td><td>${escapeHtml(r.dept)}</td>`
          }
          ${depts
            .map((d) => `<td class="num">${r.ratings[d.id] == null ? "—" : r.ratings[d.id]}</td>`)
            .join("")}
          <td>${r.submitted ? (isAdminView ? "已提交" : fmt(r.submittedAt)) : "未提交"}</td>
        </tr>`
        )
        .join("")}
      <tr class="avg"><td>平均分</td>${isAdminView ? "" : "<td></td>"}
        ${avg.map((v) => `<td class="num">${v === "" ? "—" : v}</td>`).join("")}
        <td></td></tr>
    </tbody>`;
  wrap.hidden = false;
}

async function switchToResults(roundId) {
  document.querySelectorAll("#tabs button").forEach((b) => b.classList.remove("active"));
  document
    .querySelector('#tabs button[data-tab="results"]')
    .classList.add("active");
  document.querySelectorAll(".tabpanel").forEach((p) => p.classList.remove("active"));
  document.getElementById("panel-results").classList.add("active");
  await loadRoundsLightForSelector(roundId);
  if (roundId) document.getElementById("resultRound").value = roundId;
  await loadResults();
}

async function loadRoundsLightForSelector(selectId) {
  if (!roundsCache.length) await loadRoundsDataOnly();
  if (selectId) {
    const sel = document.getElementById("resultRound");
    if ([...sel.options].some((o) => o.value === selectId)) sel.value = selectId;
  }
}

async function loadRoundsDataOnly() {
  const snap = await getDocs(query(collection(db, "rounds"), orderBy("createdAt", "desc")));
  roundsCache = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  activeRound = roundsCache.find((r) => r.status === "active") || null;
  populateResultSelector();
}

async function loadResults() {
  const sel = document.getElementById("resultRound");
  const meta = document.getElementById("resultMeta");
  if (!roundsCache.length) await loadRoundsDataOnly();
  const id = sel.value;
  const round = roundsCache.find((r) => r.id === id);
  if (!round) {
    document.getElementById("resultTableWrap").hidden = true;
    meta.textContent = "暂无期次，请先创建";
    resultState = { round: null, rows: [] };
    return;
  }
  meta.textContent = "加载中…";
  try {
    await renderResults(round);
  } catch (e) {
    meta.textContent = "加载失败：" + zhError(e);
  }
}

document.getElementById("btnResultRefresh").addEventListener("click", loadResults);
document.getElementById("resultRound").addEventListener("change", loadResults);
document.getElementById("btnDownloadCsv").addEventListener("click", async () => {
  try {
    const sel = document.getElementById("resultRound");
    let round = resultState.round;
    if (!round || round.id !== sel.value) {
      if (!roundsCache.length) await loadRoundsDataOnly();
      round = roundsCache.find((r) => r.id === sel.value);
      if (!round) return alert("请先选择期次");
      resultState.rows = await buildResultRows(round);
      resultState.round = round;
    }
    exportRoundCsv(round, resultState.rows);
  } catch (e) {
    alert("下载失败：" + zhError(e));
  }
});

// ---------------- 加载器注册与初始化 ----------------
const loaders = {
  admins: loadAdmins,
  rounds: loadRounds,
  scorers: async () => {
    if (!activeRound) await loadRoundsDataOnly();
    loadScorers();
  },
  depts: loadDepts,
  results: loadResults,
};

// 首屏：行领导直接看结果；其余进期次管理
(async function init() {
  if (isLeader) {
    document.querySelectorAll("#tabs button").forEach((b) => b.classList.remove("active"));
    document.querySelector('#tabs button[data-tab="results"]').classList.add("active");
    document.querySelectorAll(".tabpanel").forEach((p) => p.classList.remove("active"));
    document.getElementById("panel-results").classList.add("active");
    await loadRoundsDataOnly();
    await loadResults();
    return;
  }
  await loadRounds();
})();
