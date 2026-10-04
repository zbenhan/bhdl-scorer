// 打分结果 CSV 导出（带 UTF-8 BOM，Excel 打开中文不乱码）

function csvCell(v) {
  const s = v == null ? "" : String(v);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function fmtTime(ts) {
  if (!ts) return "";
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(
    d.getHours()
  )}:${pad2(d.getMinutes())}`;
}

/**
 * 导出一期的打分结果
 * @param {object} round 期次对象（含 name、depts=[{id,name}]）
 * @param {Array}  rows  [{employeeId, dept, submitted, ratings:{deptId:number}, submittedAt}]
 */
export function exportRoundCsv(round, rows, opts = {}) {
  const depts = round.depts || [];
  const anonymous = !!opts.anonymous;
  const header = anonymous
    ? ["打分人员", ...depts.map((d) => d.name)]
    : ["员工号", "所属部门", ...depts.map((d) => d.name), "提交时间"];

  const lines = [header.map(csvCell).join(",")];

  let sumByDept = depts.map(() => 0);
  let cntByDept = depts.map(() => 0);

  rows.forEach((r, i) => {
    const vals = depts.map((d) => {
      const v = r.ratings ? r.ratings[d.id] : null;
      if (typeof v === "number") {
        sumByDept[depts.indexOf(d)] += v;
        cntByDept[depts.indexOf(d)] += 1;
      }
      return v == null ? "" : v;
    });
    const row = anonymous
      ? [`匿名 ${i + 1} 号`, ...vals]
      : [r.employeeId || "", r.dept || "", ...vals, r.submitted ? fmtTime(r.submittedAt) : "未提交"];
    lines.push(row.map(csvCell).join(","));
  });

  // 平均分行
  const avgs = sumByDept.map((sum, i) =>
    cntByDept[i] ? Math.round((sum / cntByDept[i]) * 100) / 100 : ""
  );
  lines.push((anonymous ? ["平均分", ...avgs] : ["平均分", "", ...avgs, ""]).map(csvCell).join(","));

  const csv = "\uFEFF" + lines.join("\r\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const today = new Date();
  const stamp = `${today.getFullYear()}${pad2(today.getMonth() + 1)}${pad2(
    today.getDate()
  )}`;
  const a = document.createElement("a");
  a.href = url;
  a.download = `打分结果_${round.name}_${stamp}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
