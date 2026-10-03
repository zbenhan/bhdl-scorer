// 打分页逻辑
import { db } from "./firebase.js";
import {
  collection,
  query,
  where,
  orderBy,
  getDocs,
  getDoc,
  doc,
  setDoc,
  serverTimestamp,
} from "firebase/firestore";
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
  if (!ts) return "";
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}`;
}

async function loadActiveRound() {
  const q = query(
    collection(db, "rounds"),
    where("status", "==", "active"),
    orderBy("createdAt", "desc")
  );
  const snap = await getDocs(q);
  if (snap.empty) return null;
  if (snap.size > 1) {
    showMessage("warn", "检测到多个进行中期次，已默认打开最新一期，如需调整请联系管理员。");
  }
  const first = snap.docs[0];
  return { id: first.id, ...first.data() };
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

/** 已被其他行选中的分值立即禁用（导出供单元测试） */
export function refreshOptions(selectList) {
  const list = selectList || selects;
  const chosen = new Set(list.map((s) => s.value).filter(Boolean));
  list.forEach((s) => {
    [...s.options].forEach((o) => {
      if (!o.value) return;
      o.disabled = chosen.has(o.value) && s.value !== o.value;
    });
  });
}

function updateTip() {
  const filled = selects.filter((s) => s.value).length;
  submitTip.textContent = `已选择 ${filled} / ${selects.length} 个部门`;
}

/** 提交前校验：全部已选、分值合法且互不相同（导出供单元测试） */
export function validateSelections(selectList) {
  const list = selectList || selects;
  if (list.length === 0) return "本期没有需要打分的部门";
  const values = [];
  for (const s of list) {
    if (!s.value) return "还有部门未打分，请全部选择后再提交";
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

    const scoreSnap = await getDoc(
      doc(db, "rounds", currentRound.id, "scores", profile.key)
    );

    if (scoreSnap.exists()) {
      doneCardEl.hidden = false;
      renderDone(currentRound, scoreSnap.data());
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
      await setDoc(
        doc(db, "rounds", currentRound.id, "scores", profile.key),
        {
          key: profile.key,
          employeeId: profile.employeeId,
          dept: profile.dept || "",
          ratings,
          submittedAt: serverTimestamp(),
        },
        { merge: false }
      );
      // 成功：切换只读视图
      scoreCardEl.hidden = true;
      doneCardEl.hidden = false;
      renderDone(currentRound, {
        ratings,
        submittedAt: null,
      });
      doneTimeEl.textContent = "提交时间：" + fmtTime(new Date());
    } catch (e) {
      showMessage("error", "提交失败：" + zhError(e) + "（若您已提交过，刷新页面查看）");
      btnSubmit.disabled = false;
      btnSubmit.textContent = "确认提交打分";
    }
  });

  init();
}

// 仅在真实打分页自动启动（导入该模块做单元测试时不启动）
if (document.getElementById("btnSubmit")) {
  bootstrap();
}
