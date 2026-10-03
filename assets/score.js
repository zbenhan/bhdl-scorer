// 打分页逻辑（Bmob REST 实现）
import { api, cls, queryList, queryOne, parseTime } from "./lc.js";
import {
  requireProfile,
  renderTopBar,
  escapeHtml,
  SCORE_VALUES,
  zhError,
} from "./auth.js";

let profile = null;
let currentRound = null;
let selects = [];

const loadingEl = document.getElementById("loading");
const messageEl = document.getElementById("message");
const roundInfoEl = document.getElementById("roundInfo");
const scoreCardEl = document.getElementById("scoreCard");
const doneCardEl = document.getElementById("doneCard");
const rowsEl = document.getElementById("scoreRows");
const doneRowsEl = document.getElementById("doneRows");
const doneTimeEl = document.getElementById("doneTime");
const btnSubmit = document.getElementById("btnSubmit");
const submitTip = document.getElementById("submitTip");

function showMessage(type, msg) {
  messageEl.className = "alert " + type;
  messageEl.textContent = msg;
  messageEl.hidden = false;
}

function fmtTime(ts) {
  const d = parseTime(ts);
  if (!d) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}`;
}

async function loadActiveRound() {
  const list = await queryList("rounds", {
    cond: { status: "active" },
    order: "-createdAt",
    limit: 10,
  });
  if (!list.length) return null;
  if (list.length > 1) {
    showMessage("warn", "检测到多个进行中期次，已默认打开最新一期，如需调整请联系管理员。");
  }
  const r = list[0];
  return {
    id: r.objectId,
    name: r.name,
    status: r.status,
    depts: r.depts || [],
    createdAt: parseTime(r.createdAt),
  };
}

function renderForm(round) {
  const depts = round.depts || [];
  rowsEl.innerHTML = "";
  selects = [];

  depts.forEach((d, idx) => {
    const row = document.createElement("div");
    row.className = "score-row";

    const label = document.createElement("div");
    label.className = "dept-name";
    label.textContent = `${idx + 1}. ${d.name}`;

    const sel = document.createElement("select");
    sel.dataset.deptId = d.id;
    sel.innerHTML =
      '<option value="">请选择分值</option>' +
      SCORE_VALUES.map((v) => `<option value="${v}">${v} 分</option>`).join("");
    sel.addEventListener("change", () => {
      refreshOptions();
      updateTip();
    });

    row.append(label, sel);
    rowsEl.appendChild(row);
    selects.push(sel);
  });
}

export function refreshOptions(selectList) {
  const list = selectList || selects;
  const chosen = new Set(list.map((s) => s.value).filter(Boolean));
  list.forEach((s) => {
    [...s.options].forEach((o) => {
      if (!o.value) return;
      o.disabled = chosen.has(o.value) && s.value !== o.value;
    });
    const row = s.closest('.score-row');
    if (row) {
      if (!s.value) row.classList.add('incomplete');
      else row.classList.remove('incomplete');
    }
  });
}

function updateTip() {
  const filled = selects.filter((s) => s.value).length;
  submitTip.textContent = `已选择 ${filled} / ${selects.length} 个部门`;
}

export function validateSelections(selectList) {
  const list = selectList || selects;
  if (list.length === 0) return "本期没有需要打分的部门";
  const missing = list.filter((s) => !s.value).length;
  if (missing > 0)
    return `还有 ${missing} 个部门未打分，必须为所有部门打分后才能提交`;
  const values = [];
  for (const s of list) {
    const v = parseInt(s.value, 10);
    if (!SCORE_VALUES.includes(v)) return "存在非法分值";
    values.push(v);
  }
  if (new Set(values).size !== values.length) return "各部门分值不能相同，请检查";
  return null;
}

function renderDone(round, score) {
  const depts = round.depts || [];
  doneRowsEl.innerHTML = depts
    .map((d, i) => {
      const v = score.ratings[d.id];
      return `<div class="score-row"><div class="dept-name">${i + 1}. ${escapeHtml(
        d.name
      )}</div><span class="readonly-score">${v == null ? "—" : v + " 分"}</span></div>`;
    })
    .join("");
  doneTimeEl.textContent = score.submittedAt
    ? "提交时间：" + fmtTime(score.submittedAt)
    : "";
}

async function findMyScore(roundId, key) {
  return await queryOne("scores", { roundId, key });
}

async function init() {
  try {
    currentRound = await loadActiveRound();
    loadingEl.hidden = true;

    if (!currentRound) {
      showMessage("info", "当前没有进行中的打分期次，请等待管理员开启新一期后再登录打分。");
      return;
    }
    if (!currentRound.depts || currentRound.depts.length === 0) {
      showMessage("warn", "本期尚未配置被打分部门，请联系管理员。");
      return;
    }

    roundInfoEl.hidden = false;
    roundInfoEl.innerHTML = `
      <span class="chip">期次：${escapeHtml(currentRound.name)}</span>
      <span class="chip">打分部门数：${currentRound.depts.length}</span>
      <span class="chip">打分人：${escapeHtml(profile.employeeId)}（${escapeHtml(
      profile.dept || ""
    )}）</span>`;

    const scoreObj = await findMyScore(currentRound.id, profile.key);

    if (scoreObj) {
      doneCardEl.hidden = false;
      renderDone(currentRound, {
        ratings: scoreObj.ratings || {},
        submittedAt: scoreObj.submittedAt || scoreObj.createdAt,
      });
    } else {
      scoreCardEl.hidden = false;
      renderForm(currentRound);
      updateTip();
    }
  } catch (e) {
    loadingEl.hidden = true;
    showMessage("error", "加载失败：" + zhError(e));
  }
}

async function bootstrap() {
  profile = await requireProfile();
  if (!profile) return;
  if (profile.role !== "scorer") {
    location.replace("admin.html");
    return;
  }
  renderTopBar(profile, { active: "score.html" });

  btnSubmit.addEventListener("click", async () => {
    const err = validateSelections();
    if (err) return showMessage("error", err);
    messageEl.hidden = true;

    const ratings = {};
    selects.forEach((s) => {
      ratings[s.dataset.deptId] = parseInt(s.value, 10);
    });

    btnSubmit.disabled = true;
    btnSubmit.textContent = "提交中…";
    try {
      // 先检查是否已提交（避免重复）
      const exist = await findMyScore(currentRound.id, profile.key);
      if (exist) {
        scoreCardEl.hidden = true;
        doneCardEl.hidden = false;
        renderDone(currentRound, {
          ratings: exist.ratings || {},
          submittedAt: exist.submittedAt || exist.createdAt,
        });
        return;
      }
      await api("POST", cls("scores"), {
        roundId: currentRound.id,
        key: profile.key,
        employeeId: profile.employeeId,
        dept: profile.dept || "",
        ratings,
        submittedAt: new Date().toISOString(),
      });
      scoreCardEl.hidden = true;
      doneCardEl.hidden = false;
      renderDone(currentRound, { ratings, submittedAt: new Date().toISOString() });
    } catch (e) {
      showMessage("error", "提交失败：" + zhError(e) + "（若您已提交过，刷新页面查看）");
      btnSubmit.disabled = false;
      btnSubmit.textContent = "确认提交打分";
    }
  });

  init();
}

if (document.getElementById("btnSubmit")) {
  bootstrap();
}
