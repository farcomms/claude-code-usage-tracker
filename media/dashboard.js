const vscode = acquireVsCodeApi();
let state = { summary: null, quota: null, error: null, section: "overview", stale: false };

const SECTIONS = [
  ["overview", "Overview"], ["projects", "By project"], ["models", "By model"],
  ["quota", "Quota"], ["sessions", "Sessions"],
];
const usd = (v) => `$${(v ?? 0).toFixed(2)}`;
const tok = (n) => n >= 1e6 ? (n/1e6).toFixed(1)+"M" : n >= 1e3 ? (n/1e3).toFixed(1)+"K" : String(n ?? 0);
const pct = (v) => `${Math.round(v ?? 0)}%`;
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[c]));

const charts = {
  barRows(items, label, value, max) {
    const m = max || Math.max(1, ...items.map(value));
    return items.map((it) =>
      `<div class="row"><span class="nm">${esc(label(it))}</span><span class="bar"><i style="width:${Math.min(100, value(it)/m*100)}%"></i></span><span class="vv">${esc(usd(value(it)))}</span></div>`
    ).join("");
  },
  line(days) {
    if (!days.length) { return "<svg></svg>"; }
    const w = 600, h = 90, max = Math.max(1, ...days.map((d) => d.cost));
    const step = days.length > 1 ? w / (days.length - 1) : 0;
    const pts = days.map((d, i) => `${(i*step).toFixed(1)},${(h - d.cost/max*(h-8) - 4).toFixed(1)}`).join(" ");
    return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><polyline fill="none" stroke="var(--vscode-charts-blue,#4ea1ff)" stroke-width="2" points="${pts}"/></svg>`;
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
  if (state.error) { banner.classList.remove("hidden"); banner.textContent = state.error + (state.stale ? " — showing cached data" : ""); }
  else { banner.classList.add("hidden"); }

  document.getElementById("view").innerHTML = renderSection();
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
      return `<div class="panel"><h3>By project</h3><table><tr><th>Project</th><th>Tokens</th><th>Cost</th><th>Last active</th></tr>
        ${s.byProject.map((p) => `<tr><td>${esc(p.project)}</td><td>${tok(p.totalTokens)}</td><td>${p.costKnown?usd(p.cost):"n/a"}</td><td>${esc((p.lastActive||"").slice(0,10))}</td></tr>`).join("")}</table></div>`;
    case "models":
      if (!s) { return empty(); }
      return `<div class="panel"><h3>By model</h3>${charts.barRows(s.byModel, (m)=>m.model, (m)=>m.cost)}</div>`;
    case "sessions":
      if (!s) { return empty(); }
      return `<div class="panel"><h3>Sessions</h3><table><tr><th>Session</th><th>Project</th><th>Msgs</th><th>Tokens</th><th>Cost</th></tr>
        ${s.sessions.map((x) => `<tr><td>${esc(x.sessionId.slice(0,8))}</td><td>${esc(x.project)}</td><td>${x.messages}</td><td>${tok(x.totalTokens)}</td><td>${x.costKnown?usd(x.cost):"n/a"}</td></tr>`).join("")}</table></div>`;
    default: // overview
      if (!s) { return empty(); }
      const fh = q?.fiveHour;
      return `<div class="cards">
          <div class="card"><div class="l">Today</div><div class="v">${usd(s.today.cost)}</div><div class="d">${tok(s.today.totalTokens)} tok</div></div>
          <div class="card"><div class="l">This week</div><div class="v">${usd(s.week.cost)}</div><div class="d">${tok(s.week.totalTokens)} tok</div></div>
          <div class="card"><div class="l">This month</div><div class="v">${usd(s.month.cost)}</div><div class="d">${tok(s.month.totalTokens)} tok</div></div>
          <div class="card"><div class="l">5h quota</div><div class="v">${fh?pct(fh.utilization):"—"}</div><div class="d">${fh&&fh.resetsAt?("resets "+new Date(fh.resetsAt).toLocaleTimeString()):""}</div></div>
        </div>
        <div class="panel"><h3>Cost · last 30 days</h3>${charts.line(s.byDay.slice(-30))}</div>
        <div class="panel"><h3>Top projects</h3>${charts.barRows(s.byProject.slice(0,5), (p)=>p.project, (p)=>p.cost)}</div>
        <div class="panel"><h3>By model</h3>${charts.barRows(s.byModel, (m)=>m.model, (m)=>m.cost)}</div>`;
  }
}
function empty() { return `<div class="panel">No local usage found yet. Use Claude Code, then refresh.</div>`; }

document.getElementById("refresh").addEventListener("click", () => vscode.postMessage({ type: "refresh" }));
window.addEventListener("message", (e) => { if (e.data?.type === "state") { state = e.data; render(); } });
render();
