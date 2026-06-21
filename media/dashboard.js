const vscode = acquireVsCodeApi();
let state = { summary: null, quota: null, error: null, section: "overview", stale: false };

const SECTIONS = [
  ["overview", "Overview"], ["projects", "By project"], ["models", "By model"],
  ["quota", "Quota"], ["sessions", "Sessions"],
];
const usd = (v) => `$${(v ?? 0).toFixed(2)}`;
const tok = (n) => n >= 1e6 ? (n/1e6).toFixed(1)+"M" : n >= 1e3 ? (n/1e3).toFixed(1)+"K" : String(n ?? 0);
const pct = (v) => `${Math.round(v ?? 0)}%`;
const num = (n) => (n ?? 0).toLocaleString();
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[c]));

// "Lines written by Claude" mode — kept outside `state` so a quota refresh
// (which replaces `state`) doesn't reset the user's choice.
let linesMode = "all";
const linesOf = (x) => linesMode === "code" ? (x?.linesAddedCode ?? 0) : (x?.linesAdded ?? 0);
const linesToggle = () => `<span class="ltoggle">${[["all", "All files"], ["code", "Code only"]]
  .map(([m, l]) => `<span class="lt ${linesMode === m ? "on" : ""}" data-lm="${m}">${l}</span>`).join("")}</span>`;

const charts = {
  barRows(items, label, value, max, fmt = usd) {
    const m = max || Math.max(1, ...items.map(value));
    return items.map((it) =>
      `<div class="row"><span class="nm">${esc(label(it))}</span><span class="bar"><i style="width:${Math.min(100, value(it)/m*100)}%"></i></span><span class="vv">${esc(fmt(value(it)))}</span></div>`
    ).join("");
  },
  line(days) {
    if (!days.length) { return "<svg></svg>"; }
    const w = 600, h = 90, max = Math.max(1, ...days.map((d) => d.cost));
    const step = days.length > 1 ? w / (days.length - 1) : 0;
    const pts = days.map((d, i) => `${(i*step).toFixed(1)},${(h - d.cost/max*(h-8) - 4).toFixed(1)}`).join(" ");
    return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><polyline fill="none" style="stroke:var(--claude-orange);stroke-width:2" points="${pts}"/></svg>`;
  },
  quotaBar(label, b) {
    if (!b) { return ""; }
    const u = b.utilization, color = u >= 80 ? "#ff6b6b" : u >= 60 ? "#ffd93d" : "#51cf66";
    const resets = b.resetsAt ? ` · resets ${new Date(b.resetsAt).toLocaleString()}` : "";
    return `<div class="row"><span class="nm">${esc(label)}</span><span class="bar"><i style="width:${Math.min(100,u)}%;background:${color}"></i></span><span class="vv">${pct(u)}</span></div><div style="font-size:10px;opacity:.6;margin:-2px 0 6px 138px">${esc(resets)}</div>`;
  },
};

function render() {
  document.getElementById("tabs").innerHTML = SECTIONS.map(([id, lbl]) =>
    `<span class="tab ${id===state.section?"active":""}" data-s="${id}">${lbl}</span>`).join("");
  document.querySelectorAll(".tab").forEach((el) =>
    el.addEventListener("click", () => vscode.postMessage({ type: "navigate", section: el.dataset.s })));

  const banner = document.getElementById("banner");
  if (state.error) { banner.classList.remove("hidden"); banner.textContent = state.error.message + (state.stale ? " — showing cached data" : ""); }
  else { banner.classList.add("hidden"); }

  document.getElementById("view").innerHTML = renderSection();
  document.querySelectorAll("[data-lm]").forEach((el) =>
    el.addEventListener("click", () => { linesMode = el.dataset.lm; render(); }));
  const s = state.summary;
  document.getElementById("footer").textContent =
    (s ? `Updated ${new Date(state.quota?.fetchedAt || Date.now()).toLocaleTimeString()} · ` : "") +
    "Quota via api.anthropic.com/api/oauth/usage · cost computed locally";
}

function renderSection() {
  const s = state.summary, q = state.quota;
  switch (state.section) {
    case "quota":
      if (!q) { return `<div class="panel">No quota data yet.</div>`; }
      return `<div class="panel"><h3>Quota windows</h3>
        ${charts.quotaBar("5-Hour", q.fiveHour)}${charts.quotaBar("7-Day", q.sevenDay)}
        ${charts.quotaBar("7-Day Sonnet", q.sevenDaySonnet)}${charts.quotaBar("7-Day Opus", q.sevenDayOpus)}
        ${charts.quotaBar("7-Day OAuth Apps", q.sevenDayOauthApps)}</div>
        ${q.extraUsage ? `<div class="panel"><h3>Extra usage</h3><div class="row"><span class="nm">Spent / limit</span><span class="vv">${usd((q.extraUsage.usedCredits||0)/100)} / ${usd((q.extraUsage.monthlyLimit||0)/100)}</span></div></div>` : ""}`;
    case "projects":
      if (!s) { return empty(); }
      return `<div class="panel"><h3>By project ${linesToggle()}</h3><table><tr><th>Project</th><th>Tokens</th><th>Cost</th><th>Lines</th><th>Last active</th></tr>
        ${s.byProject.map((p) => `<tr><td>${esc(p.project)}</td><td>${tok(p.totalTokens)}</td><td>${p.costKnown?usd(p.cost):"n/a"}</td><td>${num(linesOf(p))}</td><td>${esc((p.lastActive||"").slice(0,10))}</td></tr>`).join("")}</table>
        <div class="hint">Lines = lines Claude wrote in accepted edits (matches Anthropic's "lines of code accepted"). Counts authored output, not surviving codebase lines.</div></div>`;
    case "models":
      if (!s) { return empty(); }
      return `<div class="panel"><h3>By model ${linesToggle()}</h3><table><tr><th>Model</th><th>Tokens</th><th>Cost</th><th>Lines</th></tr>
        ${s.byModel.map((m) => `<tr><td>${esc(m.model)}</td><td>${tok(m.totalTokens)}</td><td>${m.costKnown?usd(m.cost):"n/a"}</td><td>${num(linesOf(m))}</td></tr>`).join("")}</table></div>`;
    case "sessions":
      if (!s) { return empty(); }
      return `<div class="panel"><h3>Sessions</h3><table><tr><th>Session</th><th>Project</th><th>Msgs</th><th>Tokens</th><th>Cost</th></tr>
        ${s.sessions.map((x) => `<tr><td>${esc(x.sessionId.slice(0,8))}</td><td>${esc(x.project)}</td><td>${x.messages}</td><td>${tok(x.totalTokens)}</td><td>${x.costKnown?usd(x.cost):"n/a"}</td></tr>`).join("")}</table></div>`;
    default: // overview
      if (!s) { return empty(); }
      const fh = q?.fiveHour;
      return `<div class="cards">
          <div class="card"><div class="l">Today</div><div class="v">${usd(s.today.cost)}</div><div class="d">${tok(s.today.totalTokens)} tok · ${num(linesOf(s.today))} lines</div></div>
          <div class="card"><div class="l">This week</div><div class="v">${usd(s.week.cost)}</div><div class="d">${tok(s.week.totalTokens)} tok · ${num(linesOf(s.week))} lines</div></div>
          <div class="card"><div class="l">This month</div><div class="v">${usd(s.month.cost)}</div><div class="d">${tok(s.month.totalTokens)} tok · ${num(linesOf(s.month))} lines</div></div>
          <div class="card"><div class="l">5h quota</div><div class="v">${fh?pct(fh.utilization):"—"}</div><div class="d">${fh&&fh.resetsAt?("resets "+new Date(fh.resetsAt).toLocaleTimeString()):""}</div></div>
        </div>
        <div class="panel"><h3>Cost · last 30 days</h3>${charts.line(s.byDay.slice(-30))}</div>
        <div class="panel"><h3>Lines written by Claude ${linesToggle()}</h3>
          <div class="row"><span class="nm">Total · ${linesMode==="code"?"code":"all files"}</span><span class="bar"></span><span class="vv">${num(linesOf(s.totals))}</span></div>
          ${charts.barRows(s.byProject.slice(0,5), (p)=>p.project, (p)=>linesOf(p), null, num)}</div>
        <div class="panel"><h3>Top projects · cost</h3>${charts.barRows(s.byProject.slice(0,5), (p)=>p.project, (p)=>p.cost)}</div>
        <div class="panel"><h3>By model · cost</h3>${charts.barRows(s.byModel, (m)=>m.model, (m)=>m.cost)}</div>`;
  }
}
function empty() { return `<div class="panel">No local usage found yet. Use Claude Code, then refresh.</div>`; }

document.getElementById("refresh").addEventListener("click", () => vscode.postMessage({ type: "refresh" }));
window.addEventListener("message", (e) => { if (e.data?.type === "state") { state = e.data; render(); } });
render();
