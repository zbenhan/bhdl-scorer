// 管理后台全部逻辑（Bmob REST 实现）
import { api, cls, queryList, queryOne, queryCount, parseTime } from "./lc.js";
import {
  requireProfile,
  renderTopBar,
  escapeHtml,
  zhError,
  profileFromRow,
  managerCreateAccount,
  managerResetPassword,
  managerSetActive,
  managerDeleteScorer,
  isManagerProfile,
} from "./auth.js";
import { exportRoundCsv } from "./csv.js";

const profile = await requireProfile();
if (!profile) throw new Error("no profile");
const isSuper = profile.role === "superadmin";
const isAdminView = profile.role === "admin"; // 管理员：结果匿名、不可下载
if (!isManagerProfile(profile)) {
  location.replace("score.html");
  throw new Error("redirect");
}
renderTopBar(profile, { active: "admin.html" });

if (isAdminView) {
  document.getElementById("btnDownloadCsv").hidden = true;
}

// ---------------- 通用工具 ----------------
function fmt(ts) {
  const d = parseTime(ts);
  if (!d) return "";
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(
    d.getHours()
  )}:${p(d.getMinutes())}`;
}

/** 随机打乱数组（结果行随机排列，避免按员工号/部门推断身份） */
function shuffleRows(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** 是否所有打分人员均已提交（全部提交前不显示/下载分数） */
function allSubmitted(rows) {
  return rows.length > 0 && rows.every((r) => r.submitted);
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
    const t1 = prev.createdAt ? prev.createdAt.getTime() : 0;
    const t2 = p.createdAt ? p.createdAt.getTime() : 0;
    if (t2 >= t1) map.set(p.key, p);
  }
}

/** 查询某类角色的全部档案（含历史代次） */
async function listProfilesByRoles(roles) {
  const cond = roles.length === 1 ? { role: roles[0] } : { role: { $in: roles } };
  const rows = await queryList("profiles", { cond, order: "createdAt", limit: 1000 });
  return rows.map(profileFromRow);
}

// ---------------- 选项卡 ----------------
const tabsEl = document.getElementById("tabs");
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
  const roleText = { admin: "管理员" };
  try {
    const all = await listProfilesByRoles(["admin"]);
    const map = new Map();
    all.forEach((p) => pushCurrent(map, p));
    const list = [...map.values()].sort(
      (a, b) => (a.createdAt ? a.createdAt.getTime() : 0) - (b.createdAt ? b.createdAt.getTime() : 0)
    );

    if (!list.length) {
      tbody.innerHTML = '<tr><td colspan="5" class="muted">暂无管理员账号</td></tr>';
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
  const employeeId = input.value.trim();
  try {
    await managerCreateAccount({ employeeId, role: "admin" });
    showAlert("Admins", "ok", `管理员 ${employeeId} 已添加，初始密码 000000`);
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
function roundToPlain(r) {
  return {
    id: r.objectId,
    name: r.name,
    status: r.status,
    depts: r.depts || [],
    createdAt: parseTime(r.createdAt),
    createdBy: r.createdBy || "",
  };
}

async function loadRounds() {
  const tbody = document.getElementById("tbodyRounds");
  tbody.innerHTML = '<tr><td colspan="6" class="loading">加载中…</td></tr>';
  try {
    const rows = await queryList("rounds", { order: "-createdAt", limit: 200 });
    const rounds = rows.map(roundToPlain);

    await Promise.all(
      rounds.map(async (r) => {
        r.scoreCount = await queryCount("scores", { roundId: r.id });
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
            await api("PUT", cls("rounds") + "/" + r.id, { status: "closed" });
            loadRounds();
          }
        } else if (action === "reopen") {
          const anyActive = rounds.some((x) => x.status === "active");
          if (anyActive) {
            showAlert("Rounds", "error", "已有进行中的期次，请先关闭后再开启本期");
            return;
          }
          if (confirm(`确定重新开启期次「${r.name}」吗？`)) {
            await api("PUT", cls("rounds") + "/" + r.id, { status: "active" });
            loadRounds();
          }
        } else if (action === "csv") {
          const rows = await buildResultRows(r);
          if (!allSubmitted(rows)) {
            showAlert("Rounds", "error", `期次「${r.name}」尚有人员未提交，全部提交完成前不能下载结果`);
            return;
          }
          exportRoundCsv(r, shuffleRows(rows));
        } else if (action === "clear") {
          if (
            confirm(
              `确定清空期次「${r.name}」的全部 ${r.scoreCount} 份打分吗？\n清空后所有打分人员可重新打分。建议先下载结果存档！`
            )
          ) {
            const list = await queryList("scores", { cond: { roundId: r.id }, limit: 1000 });
            for (const s of list) {
              await api("DELETE", cls("scores") + "/" + s.objectId);
            }
            showAlert("Rounds", "ok", "本期打分已清空");
            loadRounds();
          }
        } else if (action === "delete") {
          if (confirm(`确定删除期次「${r.name}」吗？此操作不可恢复。`)) {
            await api("DELETE", cls("rounds") + "/" + r.id);
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

/** 期次最多保留 5 期：自动删除最旧的期次及其打分数据，返回删除数量 */
async function pruneRounds(maxKeep = 5) {
  const rows = await queryList("rounds", { order: "-createdAt", limit: 200 });
  // 保留最新的 maxKeep 期；进行中的期次永不删除
  const toDelete = rows.filter((r, i) => i >= maxKeep && r.status !== "active");
  for (const r of toDelete) {
    const scores = await queryList("scores", { cond: { roundId: r.objectId }, limit: 1000 });
    for (const s of scores) {
      await api("DELETE", cls("scores") + "/" + s.objectId);
    }
    await api("DELETE", cls("rounds") + "/" + r.objectId);
  }
  return toDelete.length;
}

document.getElementById("formRoundAdd").addEventListener("submit", async (e) => {
  e.preventDefault();
  hideAlert("Rounds");
  const nameInput = document.getElementById("roundName");
  const name = nameInput.value.trim();
  try {
    const existActive = roundsCache.some((r) => r.status === "active");
    if (existActive) {
      showAlert("Rounds", "error", "已有进行中的期次，请先关闭后再创建新期次");
      return;
    }
    const deptRows = await queryList("departments", {
      cond: { active: true },
      order: "sortOrder",
      limit: 200,
    });
    const depts = deptRows.map((d) => ({ id: d.objectId, name: d.name }));
    if (!depts.length) {
      showAlert("Rounds", "error", "还没有启用的被打分部门，请先在「被打分部门」页签添加");
      return;
    }
    await api("POST", cls("rounds"), {
      name,
      status: "active",
      depts,
      createdBy: profile.employeeId,
    });
    const pruned = await pruneRounds(5);
    showAlert(
      "Rounds",
      "ok",
      `期次「${name}」已创建并开启` +
        (pruned ? `；系统最多保留 5 期，已自动删除最早的 ${pruned} 个期次` : "")
    );
    loadRounds();
  } catch (err) {
    showAlert("Rounds", "error", zhError(err));
  }
});

// ===================================================================
// 打分人员
// ===================================================================
async function loadScorers() {
  const tbody = document.getElementById("tbodyScorers");
  tbody.innerHTML = '<tr><td colspan="4" class="loading">加载中…</td></tr>';
  try {
    const all = await listProfilesByRoles(["scorer"]);
    const map = new Map();
    all.forEach((p) => pushCurrent(map, p));
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
          <button class="ghost small" data-action="toggle">${p.active ? "停用" : "启用"}</button>
          <button class="ghost small danger-text" data-action="resetPwd">重置密码</button>
          <button class="ghost small danger-text" data-action="resetScore" ${
            activeRound ? "" : "disabled"
          }>重置本期打分</button>
          <button class="ghost small danger-text" data-action="delete">删除</button>
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
    if (btn.dataset.action === "toggle") {
      if (!p.active || confirm(`确定停用打分人员 ${p.employeeId} 吗？停用后将立即无法登录。`)) {
        await managerSetActive(p, !p.active);
        loadScorers();
      }
    } else if (btn.dataset.action === "delete") {
      if (
        confirm(
          `确定删除打分人员 ${p.employeeId} 吗？\n删除后该账号无法再登录，历史打分记录保留。`
        )
      ) {
        await managerDeleteScorer(p);
        showAlert("Scorers", "ok", `已删除打分人员 ${p.employeeId}`);
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
      const existing = await queryOne("scores", {
        roundId: activeRound.id,
        key: p.key,
      });
      if (!existing) {
        showAlert("Scorers", "info", `${p.employeeId} 在本期还未打分，无需重置`);
        return;
      }
      if (confirm(`确定重置 ${p.employeeId} 在「${activeRound.name}」的打分吗？对方可重新打分。`)) {
        await api("DELETE", cls("scores") + "/" + existing.objectId);
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
function deptToPlain(d) {
  return {
    id: d.objectId,
    name: d.name,
    active: d.active !== false,
    sortOrder: d.sortOrder || 0,
    createdAt: parseTime(d.createdAt),
  };
}

async function loadDepts() {
  const tbody = document.getElementById("tbodyDepts");
  tbody.innerHTML = '<tr><td colspan="4" class="loading">加载中…</td></tr>';
  try {
    const rows = await queryList("departments", { order: "sortOrder", limit: 200 });
    const list = rows.map(deptToPlain);
    if (!list.length) {
      tbody.innerHTML = '<tr><td colspan="4" class="muted">暂无部门</td></tr>';
      return;
    }
    tbody.innerHTML = list
      .map(
        (d, i) => `
      <tr>
        <td class="num">${i + 1}</td>
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
    await api("POST", cls("departments"), {
      name,
      active: true,
      sortOrder: nextSort,
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
  try {
    if (btn.dataset.action === "rename") {
      const v = prompt("修改部门名称：", d.name);
      if (v != null && v.trim() && v.trim() !== d.name) {
        await api("PUT", cls("departments") + "/" + d.id, { name: v.trim() });
        loadDepts();
      }
    } else if (btn.dataset.action === "toggle") {
      await api("PUT", cls("departments") + "/" + d.id, { active: !d.active });
      loadDepts();
    } else if (btn.dataset.action === "delete") {
      if (
        confirm(
          `确定删除部门「${d.name}」吗？\n历史期次已保存该部门的打分快照，不受影响；未关闭的期次不再包含它。`
        )
      ) {
        await api("DELETE", cls("departments") + "/" + d.id);
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
  const [scoreList, scorerProfiles] = await Promise.all([
    queryList("scores", { cond: { roundId: round.id }, limit: 1000 }),
    listProfilesByRoles(["scorer"]),
  ]);

  const scoreMap = new Map();
  scoreList.forEach((s) => {
    if (!scoreMap.has(s.key)) {
      scoreMap.set(s.key, {
        ratings: s.ratings || {},
        submittedAt: parseTime(s.submittedAt) || parseTime(s.createdAt),
      });
    }
  });

  const curMap = new Map();
  scorerProfiles.forEach((p) => pushCurrent(curMap, p));
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
  const allDone = allSubmitted(rows);
  meta.textContent =
    `期次「${round.name}」：应打分 ${rows.length} 人，已提交 ${submitted} 人，未提交 ${
      rows.length - submitted
    } 人` +
    (allDone
      ? isAdminView
        ? "（匿名视图：已提交打分人不显示身份）"
        : ""
      : "（尚有人员未提交，全部提交完成前不显示任何分数）");

  const avg = allDone
    ? depts.map((d) => {
        const vals = rows.map((r) => r.ratings[d.id]).filter((v) => typeof v === "number");
        if (!vals.length) return "";
        return Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 100) / 100;
      })
    : depts.map(() => "");

  const viewRows = shuffleRows(rows);

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
              ? r.submitted
                ? `<td class="muted">匿名 ${i + 1} 号</td>`
                : `<td>${escapeHtml(r.employeeId)}</td>`
              : `<td>${escapeHtml(r.employeeId)}</td><td>${escapeHtml(r.dept)}</td>`
          }
          ${depts
            .map(
              (d) =>
                `<td class="num">${
                  allDone && r.ratings[d.id] != null ? r.ratings[d.id] : "—"
                }</td>`
            )
            .join("")}
          <td>${r.submitted ? (isAdminView ? "已提交" : fmt(r.submittedAt)) : `未提交${isAdminView ? "（" + escapeHtml(r.dept) + "）" : ""}`}</td>
        </tr>`
        )
        .join("")}
      <tr class="avg"><td>平均分</td>${isAdminView ? "" : "<td></td>"}
        ${avg.map((v) => `<td class="num">${v === "" ? "—" : v}</td>`).join("")}
        <td></td></tr>
    </tbody>`;
  wrap.hidden = false;
}

async function loadRoundsDataOnly() {
  const rows = await queryList("rounds", { order: "-createdAt", limit: 200 });
  roundsCache = rows.map(roundToPlain);
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
    if (!allSubmitted(resultState.rows)) {
      return alert("尚有人员未提交，全部提交完成前不能下载结果");
    }
    exportRoundCsv(round, shuffleRows(resultState.rows));
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

// 首屏：超管只管「管理员账号」；管理员进期次管理
(async function init() {
  if (isSuper) {
    // 超级管理员：仅显示「管理员账号」页签，隐藏其余业务页签
    document.querySelectorAll("#tabs button").forEach((b) => {
      const show = b.dataset.tab === "admins";
      b.hidden = !show;
      b.style.display = show ? "" : "none";
      b.classList.toggle("active", show);
    });
    document.querySelectorAll(".tabpanel").forEach((p) => p.classList.remove("active"));
    document.getElementById("panel-admins").classList.add("active");
    document.querySelector(".page-title").textContent = "管理员账号管理";
    document.querySelector(".page-sub").textContent =
      "创建与管理「管理员」账号；打分期次、人员、部门与结果由管理员负责。";
    await loadAdmins();
    return;
  }
  await loadRounds();
})();
