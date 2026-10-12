"use strict";

const CONFIG = Object.freeze({
  owner: "dnjs3", repository: "dlslrhdwn", branch: "main", apiVersion: "2022-11-28",
  maxFileSize: 20 * 1024 * 1024, rawDirectory: "data/raw", indexPath: "data/processed/index.json",
  matrixManifestPath: "data/processed/matrix-manifest.json",
  analysisHistoryPath: "data/history/analysis-history.json", updateHistoryPath: "data/history/update-history.json", pollInterval: 3500,
});

const state = {
  token: null, selectedUpload: null, files: [], analysisHistory: [], updateHistory: [], selectedFileId: null,
  workbook: null, selectedSheetId: null, currentPage: 1, activeRun: null, pollTimer: null, elapsedTimer: null,
  accessOpen: false, authenticationPending: false, authenticationTimer: null,
  authenticationRequestId: 0, authenticationController: null,
  matrixRecords: [], matrixSources: [], matrixLoaded: false, matrixLoading: false, matrixFileSignature: "", matrixModalParameter: null,
  matrixManifest: null, matrixShardCache: new Map(), matrixDefaultApplied: false, matrixSelectionTimer: null, matrixLoadRequestId: 0,
};

const ids = [
  "login-screen", "app-screen", "login-form", "token-input", "token-panel", "token-submit", "login-status", "lock-button",
  "access-control", "logout-button", "mobile-menu-button",
  "run-progress", "progress-status", "progress-file", "progress-elapsed", "progress-message", "progress-percent", "progress-bar",
  "progress-steps", "progress-actions", "progress-retry", "file-input", "file-dropzone", "file-label", "upload-button",
  "upload-message", "file-list", "file-count", "delete-file-button", "empty-view", "processing-view", "error-view", "analysis-error-message",
  "table-view", "selected-file-name", "selected-file-meta", "sheet-select", "sheet-summary", "page-summary", "table-loading",
  "table-container", "previous-page", "next-page", "current-page", "dashboard-history", "dashboard-update",
  "dashboard-dataset-count", "dashboard-measurement-count", "dashboard-out-rate", "dashboard-missing-spec",
  "dashboard-spec-position", "dashboard-status-donut", "dashboard-status-legend", "dashboard-parameter-bars", "dashboard-chambers", "dashboard-heatmap",
  "history-total", "history-success", "history-failure", "history-average", "history-body", "updates-timeline",
  "matrix-kit-start", "matrix-kit-end", "matrix-kit-extra", "matrix-kit-clear", "matrix-kit-selection-summary", "matrix-kit-available",
  "matrix-product-select", "matrix-product-search", "matrix-parameter-search",
  "matrix-parameter-count", "matrix-kit-count", "matrix-record-count", "matrix-filter-summary", "matrix-loading", "matrix-loading-message",
  "matrix-empty", "matrix-card-grid", "matrix-modal", "matrix-modal-title", "matrix-modal-subtitle", "matrix-modal-chart", "matrix-modal-table", "matrix-modal-close",
];
const elements = Object.fromEntries(ids.map((id) => [id.replace(/-([a-z])/g, (_, c) => c.toUpperCase()), document.getElementById(id)]));
function showRootScreen(name) {
  elements.loginScreen.hidden = name !== "login";
  elements.appScreen.hidden = name !== "app";
}

function cancelAuthenticationAttempt() {
  clearTimeout(state.authenticationTimer); state.authenticationTimer = null; state.authenticationRequestId += 1;
  state.authenticationController?.abort(); state.authenticationController = null; state.authenticationPending = false;
  elements.tokenPanel?.removeAttribute("aria-busy");
}
function setAccessOpen(open) {
  state.accessOpen = open; elements.lockButton.setAttribute("aria-expanded", String(open)); elements.accessControl.classList.toggle("open", open); elements.tokenPanel.setAttribute("aria-hidden", String(!open));
  if (!open) { cancelAuthenticationAttempt(); elements.tokenInput.value = ""; elements.tokenSubmit.disabled = true; elements.loginStatus.textContent = ""; }
  else requestAnimationFrame(() => elements.tokenInput.focus());
}
async function authenticateCandidate(token) {
  if (!token || state.authenticationPending) return;
  const requestId = ++state.authenticationRequestId; const controller = new AbortController(); state.authenticationController = controller; state.authenticationPending = true;
  elements.tokenPanel.setAttribute("aria-busy", "true"); elements.tokenSubmit.disabled = true; elements.loginStatus.textContent = "접근 권한을 확인하고 있습니다.";
  try {
    await verifyAccess(token, controller.signal); if (requestId !== state.authenticationRequestId) return;
    state.token = token; elements.tokenInput.value = ""; elements.loginStatus.textContent = "인증되었습니다.";
    showRootScreen("app"); showView("dashboard"); showContentView("empty"); await loadAllData({ preserveSelection: false });
  } catch (error) {
    if (error.name === "AbortError" || requestId !== state.authenticationRequestId) return;
    if ([401, 403, 404].includes(Number(error.status))) { window.location.replace(new URL("access.html", document.baseURI).href); return; }
    state.token = null; elements.tokenInput.value = ""; elements.loginStatus.textContent = "인증하지 못했습니다."; elements.tokenInput.focus();
  } finally {
    if (requestId === state.authenticationRequestId) { state.authenticationPending = false; state.authenticationController = null; elements.tokenPanel.removeAttribute("aria-busy"); elements.tokenSubmit.disabled = !elements.tokenInput.value.trim(); }
  }
}

function showView(name) {
  document.querySelectorAll(".app-view").forEach((view) => { view.hidden = view.id !== `${name}-view`; });
  document.querySelectorAll("[data-view]").forEach((button) => button.classList.toggle("active", button.dataset.view === name));
  elements.runProgress.classList.toggle("outside-excel-view", name !== "excel");
  elements.appScreen.classList.remove("menu-open");
  if (name === "matrix") ensureMatrixData();
}

function showContentView(name) {
  elements.emptyView.hidden = name !== "empty"; elements.processingView.hidden = name !== "processing";
  elements.errorView.hidden = name !== "error"; elements.tableView.hidden = name !== "table";
}

function repoApi(path = "") { return `https://api.github.com/repos/${CONFIG.owner}/${CONFIG.repository}${path}`; }
function apiUrl(path = "") {
  const encoded = path.split("/").filter(Boolean).map(encodeURIComponent).join("/");
  return repoApi(encoded ? `/contents/${encoded}` : "");
}
function authHeaders(accept = "application/vnd.github+json") { return { Accept: accept, Authorization: `Bearer ${state.token}`, "X-GitHub-Api-Version": CONFIG.apiVersion }; }

async function githubRequest(url, options = {}) {
  if (!state.token) throw new Error("인증 정보가 없습니다.");
  const response = await fetch(url, { ...options, cache: "no-store", headers: { ...authHeaders(), ...options.headers } });
  if (response.status === 401 || response.status === 403) {
    handleExpiredAuthentication(response.status); const error = new Error("Token 인증이 만료되었거나 권한이 없습니다."); error.status = response.status; throw error;
  }
  return response;
}

async function verifyAccess(token, signal) {
  const headers = { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": CONFIG.apiVersion };
  const response = await fetch(repoApi(), { headers, cache: "no-store", signal });
  if (!response.ok) { const error = new Error("비공개 저장소에 접근할 수 없습니다."); error.status = response.status; throw error; }
  const repository = await response.json();
  if (repository.full_name !== `${CONFIG.owner}/${CONFIG.repository}` || !repository.private) throw new Error("지정된 비공개 저장소가 아닙니다.");
  const read = await fetch(apiUrl("README.md"), { headers, cache: "no-store", signal });
  if (!read.ok) { const error = new Error("저장소 파일 읽기 권한이 없습니다."); error.status = read.status; throw error; }
  return repository;
}

function clearRunTimers() { clearTimeout(state.pollTimer); clearInterval(state.elapsedTimer); state.pollTimer = null; state.elapsedTimer = null; }
function resetState() {
  clearRunTimers(); clearTimeout(state.matrixSelectionTimer); cancelAuthenticationAttempt(); Object.assign(state, { token: null, selectedUpload: null, files: [], analysisHistory: [], updateHistory: [], selectedFileId: null, workbook: null, selectedSheetId: null, currentPage: 1, activeRun: null, matrixRecords: [], matrixSources: [], matrixLoaded: false, matrixLoading: false, matrixFileSignature: "", matrixModalParameter: null, matrixManifest: null, matrixShardCache: new Map(), matrixDefaultApplied: false, matrixSelectionTimer: null, matrixLoadRequestId: 0 });
  elements.tokenInput.value = ""; elements.fileInput.value = ""; elements.fileLabel.textContent = "파일 선택";
  elements.uploadButton.disabled = true; elements.uploadMessage.textContent = ""; elements.runProgress.hidden = true; elements.tableContainer.replaceChildren();
  closeMatrixModal();
  setAccessOpen(false);
}
function handleExpiredAuthentication() {
  resetState(); showRootScreen("login");
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "-"; if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`; return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}
function formatDate(value) {
  const date = new Date(value); if (!value || Number.isNaN(date.getTime())) return "-";
  return new Intl.DateTimeFormat("ko-KR", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date);
}
function formatUpdateDate(value) {
  const date = new Date(value); if (!value || Number.isNaN(date.getTime())) return "날짜 미정";
  return new Intl.DateTimeFormat("ko-KR", { year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}
function formatSeconds(value) { const seconds = Number(value); return Number.isFinite(seconds) ? `${seconds.toFixed(seconds < 10 ? 1 : 0)}초` : "-"; }
function cellText(value) { if (value === null || value === undefined) return ""; return typeof value === "object" ? JSON.stringify(value) : String(value); }

async function getRawJson(path) {
  const response = await githubRequest(apiUrl(path), { headers: { Accept: "application/vnd.github.raw+json" } });
  if (!response.ok) { const error = new Error(`${path} 파일을 불러오지 못했습니다.`); error.status = response.status; throw error; }
  return response.json();
}
async function getOptionalJson(path, fallback) { try { return await getRawJson(path); } catch (error) { if (error.status === 404) return fallback; throw error; } }
async function getRawFiles() {
  const response = await githubRequest(apiUrl(CONFIG.rawDirectory)); if (response.status === 404) return [];
  if (!response.ok) throw new Error("저장된 Excel 목록을 불러오지 못했습니다.");
  return (await response.json()).filter((entry) => entry.type === "file" && entry.name.toLowerCase().endsWith(".xlsx"));
}
function mergeFileLists(rawFiles, processedIndex) {
  const byPath = new Map((processedIndex.files || []).map((file) => [file.raw_path, file]));
  return rawFiles.map((raw) => { const item = byPath.get(raw.path); return {
    id: item?.id || raw.name.replace(/\.xlsx$/i, ""), original_name: item?.original_name || raw.name, uploaded_at: item?.uploaded_at || null,
    size: raw.size, sha: raw.sha, status: item?.status || "processing", error: item?.error || null, raw_path: raw.path,
    workbook_path: item?.workbook_path || null, sheet_count: item?.sheet_count || 0, row_count: item?.row_count || 0,
    dataset_key: item?.dataset_key || null, dataset_label: item?.dataset_label || null, filename_key: item?.filename_key || datasetKeyFromFilename(item?.original_name || raw.name),
    is_duplicate: Boolean(item?.is_duplicate), duplicate_of: item?.duplicate_of || null, analytics: item?.analytics || null,
  }; }).sort((a, b) => String(b.uploaded_at || b.id).localeCompare(String(a.uploaded_at || a.id)));
}

async function loadAllData({ preserveSelection = true } = {}) {
  try {
    const [rawFiles, processed, history, updates] = await Promise.all([
      getRawFiles(), getOptionalJson(CONFIG.indexPath, { files: [] }), getOptionalJson(CONFIG.analysisHistoryPath, []), getOptionalJson(CONFIG.updateHistoryPath, []),
    ]);
    state.files = mergeFileLists(rawFiles, processed); state.analysisHistory = Array.isArray(history) ? history : history.runs || [];
    const nextMatrixSignature = matrixFileSignature();
    if (state.matrixFileSignature && state.matrixFileSignature !== nextMatrixSignature) {
      state.matrixLoaded = false; state.matrixRecords = []; state.matrixSources = []; state.matrixManifest = null; state.matrixShardCache.clear();
    }
    state.updateHistory = Array.isArray(updates) ? updates : updates.releases || updates.updates || [];
    renderFileList(); renderDashboard(); renderHistory(); renderUpdates();
    if (preserveSelection && state.selectedFileId) { const selected = state.files.find((file) => file.id === state.selectedFileId); if (selected) await selectFile(selected.id); }
  } catch (error) {
    if (state.token) { elements.uploadMessage.className = "upload-message error"; elements.uploadMessage.textContent = error.message; }
  }
}

function statusLabel(status) { return status === "ready" || status === "success" ? "완료" : status === "error" || status === "failure" ? "실패" : "분석 중"; }
function makeActivity(item, demo = false) {
  const row = document.createElement("div"); row.className = "activity-item"; const mark = document.createElement("i"); mark.className = item.status === "failure" ? "error-dot" : "success-dot";
  const copy = document.createElement("div"); const strong = document.createElement("strong"); strong.textContent = item.original_name || item.file_name || "Excel 분석";
  const small = document.createElement("small"); small.textContent = `${formatDate(item.completed_at || item.ended_at)} · ${formatSeconds(item.total_seconds)}${demo ? " · DEMO" : ""}`;
  copy.append(strong, small); row.append(mark, copy); return row;
}
function renderDashboard() {
  const files = state.files.filter((file) => file.status === "ready" && !file.is_duplicate && file.analytics);
  const summaries = files.map((file) => file.analytics.summary || {});
  const total = (field) => summaries.reduce((sum, item) => sum + (Number(item[field]) || 0), 0);
  const validActual = total("valid_actual_count"); const evaluated = total("spec_evaluated_count"); const outOfSpec = total("out_of_spec_count");
  const inSpec = total("in_spec_count"); const missingSpec = total("missing_spec_count");
  elements.dashboardDatasetCount.textContent = files.length.toLocaleString("ko-KR");
  elements.dashboardMeasurementCount.textContent = validActual.toLocaleString("ko-KR");
  elements.dashboardOutRate.textContent = evaluated ? `${((outOfSpec / evaluated) * 100).toFixed(1)}%` : "-";
  elements.dashboardMissingSpec.textContent = missingSpec.toLocaleString("ko-KR");
  renderSpecPosition(files);
  renderStatusDonut({ inSpec, outOfSpec, missingSpec, evaluated, validActual });
  renderParameterBars(files);
  renderChambers(files);
  renderHeatmap(files);

  elements.dashboardHistory.replaceChildren(); const runs = state.analysisHistory.slice(0, 4);
  if (runs.length) runs.forEach((run) => elements.dashboardHistory.append(makeActivity(run)));
  else { const empty = document.createElement("p"); empty.className = "dashboard-empty"; empty.textContent = "아직 분석 기록이 없습니다."; elements.dashboardHistory.append(empty); }
  elements.dashboardUpdate.replaceChildren(); const update = state.updateHistory[0];
  const title = document.createElement("strong"); title.textContent = update?.title || "실시간 분석 진행률";
  const body = document.createElement("p"); body.textContent = update?.summary || "업로드 후 진행 단계와 소요 시간을 확인합니다.";
  const meta = document.createElement("small"); meta.textContent = update ? formatUpdateDate(update.released_at || update.date) : "2026. 09. 30.";
  elements.dashboardUpdate.append(title, body, meta);
}

function renderSpecPosition(files) {
  const keys = ["below", "lower", "center", "upper", "above"];
  const labels = { below: "LSL 미달", lower: "하단 0~25%", center: "중앙 25~75%", upper: "상단 75~100%", above: "USL 초과" };
  const counts = Object.fromEntries(keys.map((key) => [key, files.reduce((sum, file) => sum + (Number(file.analytics.spec_position_buckets?.[key]) || 0), 0)]));
  const totalCount = keys.reduce((sum, key) => sum + counts[key], 0); elements.dashboardSpecPosition.replaceChildren();
  if (!totalCount) { const empty = document.createElement("p"); empty.className = "dashboard-empty"; empty.textContent = "LSL과 USL이 모두 있는 측정값이 없습니다."; elements.dashboardSpecPosition.append(empty); return; }
  const track = document.createElement("div"); track.className = "spec-track";
  keys.forEach((key) => { const segment = document.createElement("span"); segment.className = `spec-segment ${key}`; segment.style.width = `${(counts[key] / totalCount) * 100}%`; segment.title = `${labels[key]} ${counts[key].toLocaleString("ko-KR")}건`; track.append(segment); });
  const axis = document.createElement("div"); axis.className = "spec-axis"; axis.innerHTML = "<span>LSL 바깥</span><span>LSL 0%</span><span>규격 중앙</span><span>USL 100%</span><span>USL 바깥</span>";
  const legend = document.createElement("div"); legend.className = "spec-legend";
  keys.forEach((key) => { const item = document.createElement("div"); const label = document.createElement("span"); const value = document.createElement("strong"); label.textContent = labels[key]; value.textContent = counts[key].toLocaleString("ko-KR"); item.append(label, value); legend.append(item); });
  elements.dashboardSpecPosition.append(track, axis, legend);
}

function renderStatusDonut({ inSpec, outOfSpec, missingSpec, evaluated, validActual }) {
  const base = validActual || 1; const passEnd = (inSpec / base) * 100; const failEnd = passEnd + (outOfSpec / base) * 100;
  elements.dashboardStatusDonut.style.background = `conic-gradient(#3ba675 0 ${passEnd}%,#d6455d ${passEnd}% ${failEnd}%,#dce1e8 ${failEnd}% 100%)`;
  const center = elements.dashboardStatusDonut.querySelector("span"); center.firstChild.textContent = evaluated ? `${((inSpec / evaluated) * 100).toFixed(1)}%` : "-";
  elements.dashboardStatusLegend.replaceChildren();
  [["success-dot", `규격 내 ${inSpec.toLocaleString("ko-KR")}`], ["error-dot", `규격 이탈 ${outOfSpec.toLocaleString("ko-KR")}`], ["neutral-dot", `규격 없음 ${missingSpec.toLocaleString("ko-KR")}`]].forEach(([className, text]) => { const item = document.createElement("span"); const dot = document.createElement("i"); dot.className = className; item.append(dot, text); elements.dashboardStatusLegend.append(item); });
}

function aggregateStats(files, field, keyBuilder) {
  const result = new Map();
  files.forEach((file) => (file.analytics[field] || []).forEach((source) => { const key = keyBuilder(source); const stat = result.get(key) || { ...source, count: 0, evaluated_count: 0, out_of_spec_count: 0 }; stat.count += Number(source.count) || 0; stat.evaluated_count += Number(source.evaluated_count) || 0; stat.out_of_spec_count += Number(source.out_of_spec_count) || 0; result.set(key, stat); }));
  return [...result.values()];
}

function renderParameterBars(files) {
  const stats = aggregateStats(files, "parameter_stats", (item) => `${item.parameter}\u0000${item.unit || ""}`).sort((a, b) => b.out_of_spec_count - a.out_of_spec_count || b.count - a.count).slice(0, 8);
  elements.dashboardParameterBars.replaceChildren();
  if (!stats.length) { const empty = document.createElement("p"); empty.className = "dashboard-empty"; empty.textContent = "표시할 Parameter가 없습니다."; elements.dashboardParameterBars.append(empty); return; }
  const maximum = Math.max(...stats.map((item) => item.out_of_spec_count), 1);
  stats.forEach((item) => { const row = document.createElement("div"); row.className = "rank-row"; const label = document.createElement("span"); label.className = "rank-label"; label.textContent = `${item.parameter}${item.unit ? ` (${item.unit})` : ""}`; label.title = label.textContent; const track = document.createElement("span"); track.className = "rank-track"; const bar = document.createElement("span"); bar.style.width = `${(item.out_of_spec_count / maximum) * 100}%`; track.append(bar); const value = document.createElement("b"); value.className = "rank-value"; value.textContent = `${item.out_of_spec_count}건`; row.append(label, track, value); elements.dashboardParameterBars.append(row); });
}

function renderChambers(files) {
  const stats = aggregateStats(files, "chamber_stats", (item) => item.chamber).sort((a, b) => b.count - a.count);
  elements.dashboardChambers.replaceChildren();
  if (!stats.length) { const empty = document.createElement("p"); empty.className = "dashboard-empty"; empty.textContent = "Chamber 값이 없습니다."; elements.dashboardChambers.append(empty); return; }
  stats.slice(0, 6).forEach((item) => { const card = document.createElement("div"); card.className = "chamber-card"; const name = document.createElement("strong"); name.textContent = item.chamber; const rate = document.createElement("b"); rate.textContent = item.evaluated_count ? `${((item.out_of_spec_count / item.evaluated_count) * 100).toFixed(1)}%` : "-"; const detail = document.createElement("small"); detail.textContent = `${item.count.toLocaleString("ko-KR")}건 · 이탈 ${item.out_of_spec_count.toLocaleString("ko-KR")}건`; card.append(name, rate, detail); elements.dashboardChambers.append(card); });
}

function renderHeatmap(files) {
  const stats = aggregateStats(files, "pn_parameter_stats", (item) => `${item.pn}\u0000${item.parameter}\u0000${item.unit || ""}`);
  elements.dashboardHeatmap.replaceChildren();
  if (!stats.length) { const empty = document.createElement("p"); empty.className = "dashboard-empty"; empty.textContent = "P/N과 Parameter 조합이 없습니다."; elements.dashboardHeatmap.append(empty); return; }
  const parameterScores = new Map(); const pnScores = new Map();
  stats.forEach((item) => { const parameter = `${item.parameter}${item.unit ? ` (${item.unit})` : ""}`; const p = parameterScores.get(parameter) || [0, 0]; p[0] += item.out_of_spec_count; p[1] += item.count; parameterScores.set(parameter, p); const n = pnScores.get(item.pn) || [0, 0]; n[0] += item.out_of_spec_count; n[1] += item.count; pnScores.set(item.pn, n); });
  const ranked = (map, limit) => [...map.entries()].sort((a, b) => b[1][0] - a[1][0] || b[1][1] - a[1][1]).slice(0, limit).map(([key]) => key);
  const parameters = ranked(parameterScores, 10); const pns = ranked(pnScores, 12); const lookup = new Map(stats.map((item) => [`${item.pn}\u0000${item.parameter}${item.unit ? ` (${item.unit})` : ""}`, item]));
  const compactLabel = (value) => { if (value.length <= 28) return value; const unit = value.match(/\s\([^()]+\)$/u)?.[0] || ""; const available = Math.max(12, 27 - unit.length); return `${value.slice(0, available)}…${unit}`; };
  const table = document.createElement("table"); table.className = "heatmap-table"; const head = document.createElement("thead"); const headRow = document.createElement("tr"); const corner = document.createElement("th"); corner.textContent = "P/N"; headRow.append(corner); parameters.forEach((parameter) => { const th = document.createElement("th"); th.textContent = compactLabel(parameter); th.title = parameter; headRow.append(th); }); head.append(headRow); const body = document.createElement("tbody");
  pns.forEach((pn) => { const row = document.createElement("tr"); const label = document.createElement("th"); label.textContent = pn; label.title = pn; row.append(label); parameters.forEach((parameter) => { const cell = document.createElement("td"); const item = lookup.get(`${pn}\u0000${parameter}`); if (!item || !item.evaluated_count) { cell.className = "no-data"; cell.textContent = "·"; } else { const rate = item.out_of_spec_count / item.evaluated_count; cell.style.background = rate ? `rgba(214,69,93,${0.2 + Math.min(rate, 1) * 0.7})` : "rgba(59,166,117,.2)"; cell.textContent = rate ? `${Math.round(rate * 100)}%` : "0"; cell.title = `${pn} · ${parameter}: ${item.out_of_spec_count}/${item.evaluated_count} 이탈`; } row.append(cell); }); body.append(row); });
  table.append(head, body); elements.dashboardHeatmap.append(table);
}
function renderHistory() {
  const runs = state.analysisHistory; const successes = runs.filter((run) => run.status === "success"); const failures = runs.filter((run) => run.status === "failure");
  const average = successes.length ? successes.reduce((sum, run) => sum + (Number(run.analysis_seconds) || 0), 0) / successes.length : null;
  elements.historyTotal.textContent = String(runs.length); elements.historySuccess.textContent = String(successes.length);
  elements.historyFailure.textContent = String(failures.length); elements.historyAverage.textContent = formatSeconds(average); elements.historyBody.replaceChildren();
  if (!runs.length) { const row = document.createElement("tr"); const cell = document.createElement("td"); cell.colSpan = 8; cell.textContent = "아직 분석 기록이 없습니다."; row.append(cell); elements.historyBody.append(row); return; }
  runs.forEach((run) => { const row = document.createElement("tr"); [
    formatDate(run.completed_at || run.ended_at), run.original_name || run.file_name || "-", statusLabel(run.status), formatSeconds(run.queue_seconds),
    formatSeconds(run.analysis_seconds), formatSeconds(run.total_seconds), Number(run.row_count || 0).toLocaleString("ko-KR"), String(run.sheet_count || 0),
  ].forEach((value, index) => { const cell = document.createElement("td"); cell.textContent = value; if (index === 2) cell.className = `history-status ${run.status}`; row.append(cell); }); elements.historyBody.append(row); });
}
function mergeUpdatesByDate(updates) {
  const grouped = new Map();
  updates.forEach((update) => {
    const date = update.released_at || update.date || "";
    if (!grouped.has(date)) { grouped.set(date, { ...update, changes: [...(update.changes || [])] }); return; }
    const current = grouped.get(date);
    (update.changes || []).forEach((change) => { if (!current.changes.includes(change)) current.changes.push(change); });
  });
  return [...grouped.values()];
}
function renderUpdates() {
  elements.updatesTimeline.replaceChildren(); const source = state.updateHistory.length ? state.updateHistory : [{ date: "2026-09-30", title: "대시보드 개편", summary: "업데이트 기록 파일을 연결하면 이곳에 실제 변경 내역이 표시됩니다.", changes: ["분석 진행률", "자동 표 열기", "History 화면"] }]; const updates = mergeUpdatesByDate(source);
  updates.forEach((update) => { const card = document.createElement("article"); card.className = "update-card"; const date = document.createElement("time"); date.textContent = formatUpdateDate(update.released_at || update.date);
    const content = document.createElement("div"); const title = document.createElement("h3"); title.textContent = update.title || "변경 내역"; const summary = document.createElement("p"); summary.textContent = update.summary || "";
    const list = document.createElement("ul"); (update.changes || []).forEach((change) => { const item = document.createElement("li"); item.textContent = change; list.append(item); }); content.append(title, summary, list); card.append(date, content); elements.updatesTimeline.append(card); });
}
function renderFileList() {
  elements.fileCount.textContent = String(state.files.length); elements.fileList.replaceChildren();
  const placeholder = document.createElement("option"); placeholder.value = ""; placeholder.textContent = state.files.length ? "Excel 파일을 선택하세요" : "저장된 Excel이 없습니다."; elements.fileList.append(placeholder);
  state.files.forEach((file) => { const option = document.createElement("option"); option.value = file.id; const status = file.is_duplicate ? "중복" : statusLabel(file.status); option.textContent = `${file.original_name} · ${status} · ${formatBytes(file.size)} · ${formatDate(file.uploaded_at)}`; elements.fileList.append(option); });
  elements.fileList.value = state.files.some((file) => file.id === state.selectedFileId) ? state.selectedFileId : "";
  elements.deleteFileButton.disabled = !elements.fileList.value || Boolean(state.activeRun);
}

async function deleteSelectedFile() {
  const file = state.files.find((item) => item.id === state.selectedFileId); if (!file || !file.sha || state.activeRun) return;
  if (!window.confirm(`정말 삭제할까요?\n\n${file.original_name}\n\n삭제하면 Dashboard 집계에서도 제외됩니다.`)) return;
  elements.deleteFileButton.disabled = true; elements.uploadMessage.className = "upload-message"; elements.uploadMessage.textContent = "Excel을 삭제하고 있습니다.";
  try {
    const response = await githubRequest(apiUrl(file.raw_path), { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: `data: delete ${file.original_name}`, sha: file.sha, branch: CONFIG.branch }) });
    if (!response.ok) { let detail = {}; try { detail = await response.json(); } catch (_) { /* empty response */ } throw new Error(detail.message || "Excel 삭제에 실패했습니다."); }
    state.selectedFileId = null; state.workbook = null; state.selectedSheetId = null; showContentView("empty"); await loadAllData({ preserveSelection: false });
    elements.uploadMessage.className = "upload-message success"; elements.uploadMessage.textContent = "Excel을 삭제했습니다. Dashboard 집계에서도 제외됩니다.";
  } catch (error) { elements.uploadMessage.className = "upload-message error"; elements.uploadMessage.textContent = error.message; renderFileList(); }
}

async function selectFile(fileId) {
  const file = state.files.find((item) => item.id === fileId); if (!file) return; state.selectedFileId = fileId; renderFileList();
  if (file.status === "processing") return showContentView("processing");
  if (file.status === "error") { elements.analysisErrorMessage.textContent = file.error || "Excel 처리 중 오류가 발생했습니다."; return showContentView("error"); }
  if (!file.workbook_path) return showContentView("processing"); showContentView("table"); elements.tableLoading.hidden = false;
  try {
    state.workbook = await getRawJson(file.workbook_path); elements.selectedFileName.textContent = file.original_name;
    elements.selectedFileMeta.textContent = `${formatBytes(file.size)} · ${formatDate(file.uploaded_at)} · ${state.workbook.sheets.length}개 시트`; elements.sheetSelect.replaceChildren();
    state.workbook.sheets.forEach((sheet) => { const option = document.createElement("option"); option.value = sheet.id; option.textContent = sheet.name; elements.sheetSelect.append(option); });
    const first = state.workbook.sheets[0]; if (!first) throw new Error("표시할 시트가 없습니다."); state.selectedSheetId = first.id; state.currentPage = 1; elements.sheetSelect.value = first.id; await loadTablePage();
  } catch (error) { elements.analysisErrorMessage.textContent = error.message; showContentView("error"); } finally { elements.tableLoading.hidden = true; }
}
function selectedSheet() { return state.workbook?.sheets.find((sheet) => sheet.id === state.selectedSheetId) || null; }
async function loadTablePage() {
  const sheet = selectedSheet(); if (!sheet) return; elements.tableLoading.hidden = false;
  try {
    const pageName = `${sheet.id}-page-${String(state.currentPage).padStart(4, "0")}.json`; const page = await getRawJson(`${state.workbook.processed_directory}/${pageName}`);
    const table = document.createElement("table"); table.className = "data-table"; const head = document.createElement("thead"); const headerRow = document.createElement("tr");
    ["#", ...page.columns].forEach((column) => { const th = document.createElement("th"); th.textContent = cellText(column); headerRow.append(th); }); head.append(headerRow); const body = document.createElement("tbody");
    page.rows.forEach((values, rowIndex) => { const row = document.createElement("tr"); [page.row_offset + rowIndex + 2, ...values].forEach((value) => { const cell = document.createElement("td"); cell.textContent = cellText(value); cell.title = cell.textContent; row.append(cell); }); body.append(row); });
    table.append(head, body); elements.tableContainer.replaceChildren(table); elements.tableContainer.scrollTo({ top: 0, left: 0 });
    elements.sheetSummary.textContent = `${sheet.row_count.toLocaleString("ko-KR")}행 · ${sheet.column_count.toLocaleString("ko-KR")}열`; elements.pageSummary.textContent = `${state.currentPage} / ${sheet.page_count} 페이지`;
    elements.currentPage.textContent = `${state.currentPage} / ${sheet.page_count}`; elements.previousPage.disabled = state.currentPage <= 1; elements.nextPage.disabled = state.currentPage >= sheet.page_count;
  } catch (error) { elements.analysisErrorMessage.textContent = error.message; showContentView("error"); } finally { elements.tableLoading.hidden = true; }
}

function normalizedIdentity(value) { return String(value || "").normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ""); }
function datasetKeyFromFilename(filename) {
  const stem = String(filename || "").replace(/\.xlsx$/i, "");
  const label = stem.replace(/(?:[\s_-]+|\()\s*(?:\d{8}|\d{6}|\d{4}[-_.]\d{2}[-_.]\d{2})(?:\s*\))?$/u, "").replace(/[\s_()\-]+$/u, "");
  return normalizedIdentity(label || stem);
}
function duplicateUpload(file) {
  const key = datasetKeyFromFilename(file?.name); if (!key) return null;
  return state.files.find((item) => item.filename_key === key || datasetKeyFromFilename(item.original_name) === key) || null;
}
function validateUpload(file) {
  if (!file) return "Excel 파일을 선택하세요.";
  if (!file.name.toLowerCase().endsWith(".xlsx")) return ".xlsx 파일만 업로드할 수 있습니다.";
  if (file.size > CONFIG.maxFileSize) return "파일 크기는 20MB 이하여야 합니다.";
  if (!file.size) return "비어 있는 파일은 업로드할 수 없습니다.";
  const duplicate = duplicateUpload(file); if (duplicate) return `같은 데이터가 이미 있습니다: ${duplicate.original_name}`;
  return null;
}
function chooseUpload(file) {
  const error = validateUpload(file); state.selectedUpload = error ? null : file; elements.fileLabel.textContent = file?.name || "파일 선택";
  elements.uploadButton.disabled = Boolean(error) || Boolean(state.activeRun); elements.uploadMessage.className = `upload-message${error ? " error" : ""}`; elements.uploadMessage.textContent = error || `${formatBytes(file.size)} · 업로드할 준비가 되었습니다.`;
}
function safeFilename(filename) { const dot = filename.lastIndexOf("."); const base = (dot > 0 ? filename.slice(0, dot) : filename).normalize("NFKC").replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "workbook"; return `${base}.xlsx`; }
function uploadId() { const now = new Date(); const pad = (value) => String(value).padStart(2, "0"); const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`; const random = Array.from(crypto.getRandomValues(new Uint8Array(3)), (v) => v.toString(16).padStart(2, "0")).join(""); return `${stamp}_${random}`; }
function bytesToBase64(buffer) { const bytes = new Uint8Array(buffer); let binary = ""; for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)); return btoa(binary); }

function setProgress(percent, message, status = "processing") {
  elements.runProgress.hidden = false; elements.progressBar.style.width = `${Math.max(0, Math.min(100, percent))}%`; elements.progressPercent.textContent = `${Math.round(percent)}%`;
  elements.progressMessage.textContent = message; elements.progressStatus.className = `status-pill ${status}`; elements.progressStatus.textContent = status === "success" ? "완료" : status === "failure" ? "실패" : "분석 중";
}
function renderProgressSteps(steps = []) { elements.progressSteps.replaceChildren(); steps.forEach((step) => { const item = document.createElement("li"); item.className = step.status || "queued"; item.textContent = step.name; elements.progressSteps.append(item); }); }
function startElapsedClock() {
  clearInterval(state.elapsedTimer); const tick = () => { if (!state.activeRun) return; const seconds = Math.max(0, Math.floor((Date.now() - state.activeRun.startedAt) / 1000)); elements.progressElapsed.textContent = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`; };
  tick(); state.elapsedTimer = setInterval(tick, 1000);
}
function uploadWithProgress(path, body) {
  return new Promise((resolve, reject) => { const xhr = new XMLHttpRequest(); xhr.open("PUT", apiUrl(path)); Object.entries(authHeaders()).forEach(([name, value]) => xhr.setRequestHeader(name, value));
    xhr.upload.onprogress = (event) => { if (event.lengthComputable) setProgress(10 + (event.loaded / event.total) * 20, "비공개 저장소에 Excel을 업로드하고 있습니다."); };
    xhr.onload = () => { if (xhr.status === 401 || xhr.status === 403) { handleExpiredAuthentication(xhr.status); reject(new Error("Token 인증이 만료되었거나 권한이 없습니다.")); return; }
      let data = {}; try { data = JSON.parse(xhr.responseText || "{}"); } catch (_) { /* empty response */ } if (xhr.status < 200 || xhr.status >= 300) { reject(new Error(data.message || "Excel 업로드에 실패했습니다.")); return; } resolve(data); };
    xhr.onerror = () => reject(new Error("업로드 중 네트워크 오류가 발생했습니다.")); xhr.send(JSON.stringify(body)); });
}
function workflowProgress(run, jobs) {
  if (run.status === "queued") return [40, "GitHub Actions 실행을 기다리고 있습니다."];
  const completed = jobs.flatMap((job) => job.steps || []).filter((step) => step.status === "completed"); const last = completed.at(-1)?.name || "";
  const stages = [["Check out repository", 45], ["Capture run metadata", 48], ["Set up Python", 52], ["Install dependencies", 58], ["Run tests", 65], ["Build private preview JSON", 78], ["Commit processed data", 92]];
  const matched = stages.findLast(([name]) => last.includes(name)); return [matched?.[1] || 42, last ? `${last} 단계를 완료했습니다.` : "분석 환경을 준비하고 있습니다."];
}
async function pollActiveRun() {
  if (!state.activeRun || !state.token) return;
  try {
    let run = state.activeRun.workflowRun;
    if (!run) { const response = await githubRequest(repoApi(`/actions/runs?head_sha=${encodeURIComponent(state.activeRun.commitSha)}&event=push&per_page=5`)); if (!response.ok) throw new Error("Actions 실행 상태를 불러오지 못했습니다."); run = (await response.json()).workflow_runs?.[0];
      if (!run) { setProgress(35, "업로드를 감지했습니다. 분석 작업이 시작되기를 기다리고 있습니다."); schedulePoll(); return; } state.activeRun.workflowRun = run;
    } else { const response = await githubRequest(repoApi(`/actions/runs/${run.id}`)); if (!response.ok) throw new Error("Actions 실행 상태를 불러오지 못했습니다."); run = await response.json(); state.activeRun.workflowRun = run; }
    let jobs = []; if (run.id) { const response = await githubRequest(repoApi(`/actions/runs/${run.id}/jobs?per_page=10`)); if (response.ok) jobs = (await response.json()).jobs || []; }
    renderProgressSteps(jobs.flatMap((job) => job.steps || []).map((step) => ({ name: step.name, status: step.status === "completed" ? (step.conclusion === "success" ? "complete" : "failed") : step.status })));
    if (run.status === "completed") { if (run.conclusion === "success") { await finishRunSuccess(); return; } finishRunFailure(`분석 작업이 ${run.conclusion || "실패"} 상태로 끝났습니다.`); return; }
    const [percent, message] = workflowProgress(run, jobs); setProgress(percent, message); schedulePoll();
  } catch (error) { if (!state.token) return; setProgress(35, `${error.message} 잠시 후 다시 확인합니다.`); schedulePoll(6000); }
}
function schedulePoll(delay = CONFIG.pollInterval) { clearTimeout(state.pollTimer); state.pollTimer = setTimeout(pollActiveRun, delay); }
async function finishRunSuccess() {
  clearRunTimers(); setProgress(100, "분석이 완료되었습니다. 표를 불러오고 있습니다.", "success"); let ready = null;
  for (let attempt = 0; attempt < 6 && !ready; attempt += 1) { await loadAllData({ preserveSelection: false }); ready = state.files.find((file) => file.id === state.activeRun.fileId && file.status === "ready"); if (!ready && attempt < 5) await new Promise((resolve) => setTimeout(resolve, 1800)); }
  const target = ready || state.files.find((file) => file.status === "ready"); state.activeRun = null; elements.uploadButton.disabled = !state.selectedUpload; elements.progressActions.hidden = true;
  if (target) { showView("excel"); await selectFile(target.id); elements.uploadMessage.className = "upload-message success"; elements.uploadMessage.textContent = "분석이 끝나 표를 자동으로 열었습니다."; }
  else finishRunFailure("분석은 완료됐지만 결과 파일 확인이 늦어지고 있습니다. 다시 확인을 눌러주세요.");
}
function finishRunFailure(message) { clearRunTimers(); setProgress(100, message, "failure"); elements.progressActions.hidden = false; elements.uploadButton.disabled = !state.selectedUpload; state.activeRun = null; }

async function uploadSelectedFile() {
  const file = state.selectedUpload; const error = validateUpload(file); if (error) { chooseUpload(file); return; }
  elements.uploadButton.disabled = true; elements.fileInput.disabled = true; elements.progressActions.hidden = true; const id = uploadId(); const storedName = `${id}_${safeFilename(file.name)}`; const path = `${CONFIG.rawDirectory}/${storedName}`;
  state.activeRun = { fileId: storedName.replace(/\.xlsx$/i, ""), filename: file.name, startedAt: Date.now(), commitSha: null, workflowRun: null }; elements.progressFile.textContent = file.name;
  renderProgressSteps([{ name: "Excel 업로드", status: "in_progress" }]); startElapsedClock(); setProgress(5, "Excel 파일을 준비하고 있습니다."); showView("excel");
  try {
    const content = bytesToBase64(await file.arrayBuffer()); const result = await uploadWithProgress(path, { message: `data: upload ${file.name}`, content, branch: CONFIG.branch }); state.activeRun.commitSha = result.commit?.sha;
    if (!state.activeRun.commitSha) throw new Error("업로드 커밋 정보를 확인하지 못했습니다."); state.selectedUpload = null; elements.fileInput.value = ""; elements.fileLabel.textContent = "파일 선택";
    elements.uploadMessage.className = "upload-message success"; elements.uploadMessage.textContent = "업로드 완료. 분석 진행 상황을 자동으로 확인합니다.";
    renderProgressSteps([{ name: "Excel 업로드", status: "complete" }, { name: "Actions 실행 감지", status: "in_progress" }]); setProgress(32, "업로드가 끝났습니다. 분석 작업을 찾고 있습니다."); await loadAllData({ preserveSelection: false }); schedulePoll(700);
  } catch (uploadError) { if (state.token) { elements.uploadMessage.className = "upload-message error"; elements.uploadMessage.textContent = uploadError.message; finishRunFailure(uploadError.message); } }
  finally { elements.fileInput.disabled = false; }
}

function matrixFileSignature() {
  return state.files.filter((file) => file.status === "ready" && !file.is_duplicate && file.workbook_path)
    .map((file) => `${file.id}:${file.workbook_path}`).sort().join("|");
}
function matrixDate(file) {
  const parsed = new Date(file.uploaded_at); if (!Number.isNaN(parsed.getTime())) {
    const pad = (value) => String(value).padStart(2, "0");
    return `${parsed.getFullYear()}${pad(parsed.getMonth() + 1)}${pad(parsed.getDate())}`;
  }
  const matched = String(file.id || "").match(/(20\d{6})/); return matched?.[1] || "날짜미상";
}
function matrixText(value, fallback) { const text = String(value ?? "").trim(); return text || fallback; }
function matrixNumber(value) { if (value === null || value === undefined || String(value).trim() === "") return null; const number = Number(value); return Number.isFinite(number) ? number : null; }
function matrixKitNumber(value) {
  const text = String(value || "").normalize("NFKC"); const ckm = text.match(/CKM\s*(?:#|NO\.?)?\s*[_-]?\s*(\d+)/i);
  return ckm ? Number(ckm[1]) : null;
}
function matrixSourceLabel(kitId, file) {
  const normalized = matrixText(kitId, file.dataset_label || file.original_name || "Kit").replace(/[\\/:*?"<>|]+/g, "-");
  return `${normalized}_${matrixDate(file)}`;
}
async function loadMatrixFile(file, position, total) {
  elements.matrixLoadingMessage.textContent = `${position} / ${total} · ${file.original_name}`;
  const workbook = await getRawJson(file.workbook_path); const records = []; const sources = [];
  for (const sheet of workbook.sheets || []) {
    const sheetRecords = []; const sourceId = `${file.id}:${sheet.id}`;
    const pages = await Promise.all(Array.from({ length: sheet.page_count || 0 }, (_, index) => {
      const pageName = `${sheet.id}-page-${String(index + 1).padStart(4, "0")}.json`;
      return getRawJson(`${workbook.processed_directory}/${pageName}`);
    }));
    pages.forEach((page) => (page.rows || []).forEach((row) => {
      const actual = matrixNumber(row[13]); if (actual === null) return;
      const parameter = matrixText(row[9], "미분류 Parameter"); const kitId = matrixText(row[0], file.dataset_label || "Kit ID 없음");
      sheetRecords.push({ sourceId, sheetName: sheet.name, kitId, kitNumber: matrixKitNumber(kitId), product: matrixText(row[5], "미분류"), parameter, actual,
        lsl: matrixNumber(row[16]), usl: matrixNumber(row[18]), unit: matrixText(row[19], ""), sourceLabel: "" });
    }));
    const label = matrixSourceLabel(sheetRecords[0]?.kitId, file); sheetRecords.forEach((record) => { record.sourceLabel = label; }); records.push(...sheetRecords);
    sources.push({ id: sourceId, label, originalName: file.original_name, sheetName: sheet.name, date: matrixDate(file), count: sheetRecords.length });
  }
  return { sources, records };
}
async function loadLegacyMatrixData(signature) {
  const files = state.files.filter((file) => file.status === "ready" && !file.is_duplicate && file.workbook_path);
  const loaded = [];
  for (let index = 0; index < files.length; index += 1) loaded.push(await loadMatrixFile(files[index], index + 1, files.length));
  state.matrixRecords = loaded.flatMap((item) => item.records); state.matrixSources = loaded.flatMap((item) => item.sources);
  state.matrixFileSignature = signature; state.matrixLoaded = true; populateMatrixFilters(); renderMatrix();
}
function matrixShardPaths(selection = matrixKitSelection()) {
  const shards = state.matrixManifest?.shards || [];
  if (!selection.active) return [...shards.map((shard) => shard.path), ...(state.matrixManifest?.unnumbered_path ? [state.matrixManifest.unnumbered_path] : [])];
  return shards.filter((shard) => {
    const overlapsRange = selection.low !== null && shard.max_kit >= selection.low && shard.min_kit <= selection.high;
    return overlapsRange || selection.extras.some((number) => number >= shard.min_kit && number <= shard.max_kit);
  }).map((shard) => shard.path);
}
function normalizeMatrixAggregate(record) {
  return {
    sourceId: record.sheet_id || "aggregate", sheetName: record.sheet_name || "", kitId: matrixText(record.kit_id, "Kit ID 없음"),
    kitNumber: matrixNumber(record.kit_number), product: matrixText(record.product, "미분류"), parameter: matrixText(record.parameter, "미분류 Parameter"),
    actual: matrixNumber(record.mean), min: matrixNumber(record.min), max: matrixNumber(record.max), valueCount: Math.max(1, Number(record.count) || 1),
    lsl: matrixNumber(record.lsl), usl: matrixNumber(record.usl), unit: matrixText(record.unit, ""), sourceLabel: record.sheet_name || "집계 데이터",
    alert: Number(record.out_of_spec_count) > 0,
  };
}
async function loadMatrixSelection() {
  if (!state.matrixManifest) return;
  const requestId = ++state.matrixLoadRequestId; const paths = matrixShardPaths();
  state.matrixLoading = true; elements.matrixLoading.hidden = false; elements.matrixEmpty.hidden = true;
  elements.matrixLoadingMessage.textContent = paths.length ? `선택 구간 ${paths.length}개 데이터 조각을 불러오는 중` : "선택한 CKM 구간을 확인하는 중";
  try {
    const payloads = await Promise.all(paths.map((path) => {
      if (!state.matrixShardCache.has(path)) state.matrixShardCache.set(path, getRawJson(path).catch((error) => { state.matrixShardCache.delete(path); throw error; }));
      return state.matrixShardCache.get(path);
    }));
    if (requestId !== state.matrixLoadRequestId) return;
    state.matrixRecords = payloads.flatMap((payload) => payload.records || []).map(normalizeMatrixAggregate).filter((record) => record.actual !== null);
    state.matrixLoaded = true; populateMatrixFilters(); renderMatrix();
  } finally {
    if (requestId === state.matrixLoadRequestId) { state.matrixLoading = false; elements.matrixLoading.hidden = true; }
  }
}
async function ensureMatrixData(force = false) {
  if (!state.token) return;
  const signature = matrixFileSignature();
  if (force) { state.matrixManifest = null; state.matrixShardCache.clear(); }
  if (!force && state.matrixLoaded && state.matrixFileSignature === signature && state.matrixManifest) { await loadMatrixSelection(); return; }
  state.matrixLoading = true; elements.matrixLoading.hidden = false; elements.matrixEmpty.hidden = true; elements.matrixCardGrid.replaceChildren();
  try {
    state.matrixManifest = await getRawJson(CONFIG.matrixManifestPath);
    const kitNumbers = state.matrixManifest.kit_numbers || [];
    if (!state.matrixDefaultApplied && !elements.matrixKitStart.value && !elements.matrixKitEnd.value && !elements.matrixKitExtra.value && kitNumbers.length) {
      const recent = kitNumbers.slice(-12); elements.matrixKitStart.value = String(recent[0]); elements.matrixKitEnd.value = String(recent.at(-1)); state.matrixDefaultApplied = true;
    }
    state.matrixFileSignature = signature; populateMatrixFilters(); await loadMatrixSelection();
  } catch (error) {
    if (error.status === 404) { state.matrixManifest = null; await loadLegacyMatrixData(signature); }
    else { elements.matrixEmpty.hidden = false; elements.matrixEmpty.querySelector("h3").textContent = "매트릭스를 불러오지 못했습니다"; elements.matrixEmpty.querySelector("p").textContent = error.message; }
  } finally {
    state.matrixLoading = false; elements.matrixLoading.hidden = true;
  }
}
function populateMatrixFilters() {
  const kitNumbers = state.matrixManifest?.kit_numbers || [...new Set(state.matrixRecords.map((record) => record.kitNumber).filter(Number.isFinite))].sort((a, b) => a - b);
  if (kitNumbers.length) {
    const minimum = kitNumbers[0]; const maximum = kitNumbers.at(-1); elements.matrixKitStart.min = String(minimum); elements.matrixKitEnd.min = String(minimum);
    elements.matrixKitStart.placeholder = `시작 CKM ${minimum}`; elements.matrixKitEnd.placeholder = `끝 CKM ${maximum}`;
    elements.matrixKitAvailable.textContent = `현재 CKM ${minimum} ~ ${maximum} · ${kitNumbers.length.toLocaleString("ko-KR")}개 누적`;
  } else elements.matrixKitAvailable.textContent = "A열 제목에서 CKM 번호를 찾지 못했습니다.";
  const selectedProduct = elements.matrixProductSelect.value; const products = [...new Set(state.matrixRecords.map((record) => record.product))].sort((a, b) => a.localeCompare(b, "ko", { numeric: true }));
  elements.matrixProductSelect.replaceChildren(); const everyProduct = document.createElement("option"); everyProduct.value = ""; everyProduct.textContent = `전체 제품 (${products.length})`; elements.matrixProductSelect.append(everyProduct);
  products.forEach((product) => { const option = document.createElement("option"); option.value = product; option.textContent = product; elements.matrixProductSelect.append(option); });
  elements.matrixProductSelect.value = products.includes(selectedProduct) ? selectedProduct : "";
}
function matrixKitSelection() {
  const startValue = Number(elements.matrixKitStart.value); const endValue = Number(elements.matrixKitEnd.value);
  const hasStart = elements.matrixKitStart.value !== "" && Number.isFinite(startValue); const hasEnd = elements.matrixKitEnd.value !== "" && Number.isFinite(endValue);
  const low = hasStart && hasEnd ? Math.min(startValue, endValue) : hasStart ? startValue : hasEnd ? endValue : null;
  const high = hasStart && hasEnd ? Math.max(startValue, endValue) : low;
  const extras = [...new Set((elements.matrixKitExtra.value.match(/\d+/g) || []).map(Number).filter(Number.isFinite))].sort((a, b) => a - b);
  return { low, high, extras, active: low !== null || extras.length > 0 };
}
function matrixKitSelectionLabel(selection = matrixKitSelection()) {
  if (!selection.active) return "전체 CKM"; const labels = [];
  if (selection.low !== null) labels.push(selection.low === selection.high ? `CKM ${selection.low}` : `CKM ${selection.low} ~ ${selection.high}`);
  const additional = selection.extras.filter((number) => selection.low === null || number < selection.low || number > selection.high);
  if (additional.length) labels.push(`추가 ${additional.map((number) => `CKM ${number}`).join(", ")}`); return labels.join(" + ");
}
function filteredMatrixRecords() {
  const selection = matrixKitSelection(); const extras = new Set(selection.extras); const product = elements.matrixProductSelect.value;
  const productSearch = normalizedIdentity(elements.matrixProductSearch.value); const parameterSearch = normalizedIdentity(elements.matrixParameterSearch.value);
  return state.matrixRecords.filter((record) => (!selection.active || (record.kitNumber !== null && ((selection.low !== null && record.kitNumber >= selection.low && record.kitNumber <= selection.high) || extras.has(record.kitNumber)))) && (!product || record.product === product)
    && (!productSearch || normalizedIdentity(record.product).includes(productSearch)) && (!parameterSearch || normalizedIdentity(record.parameter).includes(parameterSearch)));
}
function matrixGroups(records) {
  const groups = new Map(); records.forEach((record) => { const group = groups.get(record.parameter) || { parameter: record.parameter, records: [], units: new Set() }; group.records.push(record); if (record.unit) group.units.add(record.unit); groups.set(record.parameter, group); });
  return [...groups.values()].sort((a, b) => a.parameter.localeCompare(b.parameter, "ko", { numeric: true }));
}
function matrixObservationCount(records) { return records.reduce((sum, record) => sum + (Number(record.valueCount) || 1), 0); }
function matrixSeries(records) {
  const kits = new Map(); records.forEach((record) => { const key = record.kitNumber !== null ? `ckm:${record.kitNumber}` : `title:${record.kitId}`; const count = Number(record.valueCount) || 1; const point = kits.get(key) || { kitId: record.kitNumber !== null ? `CKM ${record.kitNumber}` : record.kitId, kitNumber: record.kitNumber, valueSum: 0, count: 0, min: Number.POSITIVE_INFINITY, max: Number.NEGATIVE_INFINITY, lslSum: 0, lslCount: 0, uslSum: 0, uslCount: 0, sources: new Set(), alert: false }; point.valueSum += record.actual * count; point.count += count; point.min = Math.min(point.min, record.min ?? record.actual); point.max = Math.max(point.max, record.max ?? record.actual); if (record.lsl !== null) { point.lslSum += record.lsl * count; point.lslCount += count; } if (record.usl !== null) { point.uslSum += record.usl * count; point.uslCount += count; } point.sources.add(record.sourceLabel); if (record.alert || (record.lsl !== null && record.actual < record.lsl) || (record.usl !== null && record.actual > record.usl)) point.alert = true; kits.set(key, point); });
  return [...kits.values()].map((point) => ({ kitId: point.kitId, kitNumber: point.kitNumber, sourceLabels: [...point.sources], count: point.count,
    mean: point.valueSum / point.count, min: point.min, max: point.max,
    lsl: point.lslCount ? point.lslSum / point.lslCount : null,
    usl: point.uslCount ? point.uslSum / point.uslCount : null, alert: point.alert }))
    .sort((a, b) => (a.kitNumber ?? Number.MAX_SAFE_INTEGER) - (b.kitNumber ?? Number.MAX_SAFE_INTEGER) || a.kitId.localeCompare(b.kitId, "ko", { numeric: true }));
}
function formatMatrixNumber(value) {
  const absolute = Math.abs(value); const digits = absolute >= 100 ? 1 : absolute >= 10 ? 2 : absolute >= 1 ? 3 : 4;
  return Number(value).toLocaleString("ko-KR", { maximumFractionDigits: digits });
}
function svgNode(name, attributes = {}, textValue = "") {
  const node = document.createElementNS("http://www.w3.org/2000/svg", name); Object.entries(attributes).forEach(([key, value]) => node.setAttribute(key, String(value))); if (textValue) node.textContent = textValue; return node;
}
function buildMatrixChart(series, large = false) {
  const width = large ? 920 : 440; const height = large ? 390 : 205; const margin = large ? { top: 24, right: 30, bottom: 68, left: 70 } : { top: 18, right: 16, bottom: 48, left: 50 };
  const svg = svgNode("svg", { viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": "Kit ID별 Actual 매트릭스 차트", preserveAspectRatio: "none" });
  if (!series.length) return svg; let minimum = Math.min(...series.map((point) => point.min)); let maximum = Math.max(...series.map((point) => point.max));
  if (minimum === maximum) { const delta = Math.abs(minimum || 1) * .08; minimum -= delta; maximum += delta; } const padding = (maximum - minimum) * .12; minimum -= padding; maximum += padding;
  const plotWidth = width - margin.left - margin.right; const plotHeight = height - margin.top - margin.bottom;
  const x = (index) => margin.left + (series.length === 1 ? plotWidth / 2 : (index / (series.length - 1)) * plotWidth); const y = (value) => margin.top + ((maximum - value) / (maximum - minimum)) * plotHeight;
  for (let index = 0; index <= 4; index += 1) { const value = maximum - ((maximum - minimum) * index / 4); const py = margin.top + (plotHeight * index / 4); svg.append(svgNode("line", { x1: margin.left, x2: width - margin.right, y1: py, y2: py, class: "matrix-grid-line" }), svgNode("text", { x: margin.left - 8, y: py + 3, "text-anchor": "end", class: "matrix-chart-text" }, formatMatrixNumber(value))); }
  svg.append(svgNode("line", { x1: margin.left, x2: margin.left, y1: margin.top, y2: height - margin.bottom, class: "matrix-axis-line" }), svgNode("line", { x1: margin.left, x2: width - margin.right, y1: height - margin.bottom, y2: height - margin.bottom, class: "matrix-axis-line" }));
  const path = series.map((point, index) => `${index ? "L" : "M"}${x(index)},${y(point.mean)}`).join(" "); svg.append(svgNode("path", { d: path, class: "matrix-series-line" }));
  const labelStep = Math.max(1, Math.ceil(series.length / (large ? 12 : 6)));
  series.forEach((point, index) => { const px = x(index); svg.append(svgNode("line", { x1: px, x2: px, y1: y(point.max), y2: y(point.min), class: "matrix-range-line" })); const circle = svgNode("circle", { cx: px, cy: y(point.mean), r: large ? 5 : 4, class: `matrix-point${point.alert ? " alert" : ""}` }); circle.append(svgNode("title", {}, `${point.kitId}\n평균 ${formatMatrixNumber(point.mean)} · 범위 ${formatMatrixNumber(point.min)} ~ ${formatMatrixNumber(point.max)} · ${point.count}건`)); svg.append(circle);
    if (index % labelStep === 0 || index === series.length - 1) { const label = point.kitId.length > (large ? 20 : 12) ? `${point.kitId.slice(0, large ? 19 : 11)}…` : point.kitId; svg.append(svgNode("text", { x: px, y: height - margin.bottom + 17, "text-anchor": "end", transform: `rotate(-28 ${px} ${height - margin.bottom + 17})`, class: "matrix-chart-label" }, label)); } });
  return svg;
}
function renderMatrix() {
  if (!state.matrixLoaded) return; closeMatrixModal(); const records = filteredMatrixRecords(); const groups = matrixGroups(records); const kits = new Set(records.map((record) => record.kitNumber !== null ? `ckm:${record.kitNumber}` : `title:${record.kitId}`));
  const observationCount = matrixObservationCount(records); elements.matrixParameterCount.textContent = groups.length.toLocaleString("ko-KR"); elements.matrixKitCount.textContent = kits.size.toLocaleString("ko-KR"); elements.matrixRecordCount.textContent = observationCount.toLocaleString("ko-KR");
  const kitLabel = matrixKitSelectionLabel(); elements.matrixKitSelectionSummary.textContent = `${kitLabel} · 실제 데이터 ${kits.size.toLocaleString("ko-KR")}개`;
  elements.matrixFilterSummary.textContent = `${kitLabel} · ${elements.matrixProductSelect.value || "전체 F열 제품"}${elements.matrixProductSearch.value ? ` · “${elements.matrixProductSearch.value}” 검색` : ""}`;
  elements.matrixCardGrid.replaceChildren(); elements.matrixEmpty.hidden = groups.length > 0;
  groups.forEach((group, index) => { const series = matrixSeries(group.records); const groupCount = matrixObservationCount(group.records); const card = document.createElement("article"); card.className = "matrix-card"; card.tabIndex = 0; card.setAttribute("role", "button"); card.setAttribute("aria-label", `${group.parameter} 확대 보기`);
    const header = document.createElement("header"); header.className = "matrix-card-header"; const title = document.createElement("div"); title.className = "matrix-card-title"; const eyebrow = document.createElement("span"); eyebrow.textContent = `J-${String(index + 1).padStart(2, "0")}`; const heading = document.createElement("h3"); heading.textContent = group.parameter; heading.title = group.parameter; const meta = document.createElement("small"); meta.textContent = `${[...group.units].join(" · ") || "단위 없음"} · ${groupCount.toLocaleString("ko-KR")}건`; title.append(eyebrow, heading, meta); const expand = document.createElement("span"); expand.className = "matrix-expand"; expand.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5"/></svg>'; header.append(title, expand);
    const chart = document.createElement("div"); chart.className = "matrix-chart"; chart.append(buildMatrixChart(series)); const footer = document.createElement("footer"); footer.className = "matrix-card-footer"; const average = series.reduce((sum, point) => sum + point.mean * point.count, 0) / groupCount; const alerts = series.filter((point) => point.alert).length; const left = document.createElement("span"); left.innerHTML = `평균 <strong>${formatMatrixNumber(average)}</strong>`; const right = document.createElement("span"); right.textContent = `${series.length} Kit · ${alerts ? `규격 이탈 ${alerts}` : "규격 이탈 없음"}`; footer.append(left, right); card.append(header, chart, footer);
    const open = () => openMatrixModal(group); card.addEventListener("click", open); card.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); open(); } }); elements.matrixCardGrid.append(card); });
}
function openMatrixModal(group) {
  state.matrixModalParameter = group.parameter; state.matrixLastFocus = document.activeElement; const series = matrixSeries(group.records); elements.matrixModalTitle.textContent = group.parameter;
  elements.matrixModalSubtitle.textContent = `${[...group.units].join(" · ") || "단위 없음"} · ${series.length} Kit ID · ${matrixObservationCount(group.records).toLocaleString("ko-KR")}개 측정값`;
  elements.matrixModalChart.replaceChildren(buildMatrixChart(series, true)); const table = document.createElement("table"); const head = document.createElement("thead"); const headRow = document.createElement("tr"); ["A열 Kit ID", "평균", "최소", "최대", "측정 수", "판정"].forEach((label) => { const cell = document.createElement("th"); cell.textContent = label; headRow.append(cell); }); head.append(headRow); const body = document.createElement("tbody");
  series.forEach((point) => { const row = document.createElement("tr"); [point.kitId, formatMatrixNumber(point.mean), formatMatrixNumber(point.min), formatMatrixNumber(point.max), point.count.toLocaleString("ko-KR"), point.alert ? "규격 이탈 포함" : "정상"].forEach((value) => { const cell = document.createElement("td"); cell.textContent = value; row.append(cell); }); body.append(row); }); table.append(head, body); elements.matrixModalTable.replaceChildren(table); elements.matrixModal.hidden = false; document.body.classList.add("matrix-modal-open"); requestAnimationFrame(() => elements.matrixModalClose.focus());
}
function closeMatrixModal() {
  if (!elements?.matrixModal || elements.matrixModal.hidden) return; elements.matrixModal.hidden = true; document.body.classList.remove("matrix-modal-open"); state.matrixModalParameter = null; const focus = state.matrixLastFocus; state.matrixLastFocus = null; if (focus?.isConnected) focus.focus();
}

function scheduleMatrixSelectionLoad() {
  clearTimeout(state.matrixSelectionTimer);
  state.matrixSelectionTimer = setTimeout(async () => {
    try { await ensureMatrixData(); }
    catch (error) { elements.matrixEmpty.hidden = false; elements.matrixEmpty.querySelector("h3").textContent = "선택 구간을 불러오지 못했습니다"; elements.matrixEmpty.querySelector("p").textContent = error.message; }
  }, 250);
}
document.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", () => showView(button.dataset.view)));
document.querySelectorAll("[data-go-view]").forEach((button) => button.addEventListener("click", () => showView(button.dataset.goView)));
elements.mobileMenuButton.addEventListener("click", () => elements.appScreen.classList.toggle("menu-open"));
elements.loginForm.addEventListener("submit", (event) => {
  event.preventDefault();
  authenticateCandidate(elements.tokenInput.value.trim());
});
elements.lockButton.addEventListener("click", () => setAccessOpen(!state.accessOpen));
elements.tokenInput.addEventListener("input", () => { elements.loginStatus.textContent = ""; elements.tokenSubmit.disabled = !elements.tokenInput.value.trim() || state.authenticationPending; });
elements.tokenInput.addEventListener("keydown", (event) => { if (event.key === "Escape") setAccessOpen(false); });
elements.logoutButton.addEventListener("click", () => { resetState(); showRootScreen("login"); });
elements.progressRetry.addEventListener("click", async () => { elements.progressActions.hidden = true; await loadAllData({ preserveSelection: false }); const target = state.files.find((file) => file.status === "ready"); if (target) { showView("excel"); await selectFile(target.id); elements.runProgress.hidden = true; } else elements.progressActions.hidden = false; });
elements.fileInput.addEventListener("change", () => chooseUpload(elements.fileInput.files[0])); elements.uploadButton.addEventListener("click", uploadSelectedFile);
elements.fileDropzone.addEventListener("dragover", (event) => { event.preventDefault(); elements.fileDropzone.classList.add("dragging"); }); elements.fileDropzone.addEventListener("dragleave", () => elements.fileDropzone.classList.remove("dragging"));
elements.fileDropzone.addEventListener("drop", (event) => { event.preventDefault(); elements.fileDropzone.classList.remove("dragging"); chooseUpload(event.dataTransfer.files[0]); });
elements.fileList.addEventListener("change", () => { if (elements.fileList.value) selectFile(elements.fileList.value); });
elements.deleteFileButton.addEventListener("click", deleteSelectedFile);
elements.sheetSelect.addEventListener("change", async () => { state.selectedSheetId = elements.sheetSelect.value; state.currentPage = 1; await loadTablePage(); });
elements.previousPage.addEventListener("click", async () => { if (state.currentPage > 1) { state.currentPage -= 1; await loadTablePage(); } }); elements.nextPage.addEventListener("click", async () => { const sheet = selectedSheet(); if (sheet && state.currentPage < sheet.page_count) { state.currentPage += 1; await loadTablePage(); } });
elements.matrixKitStart.addEventListener("input", scheduleMatrixSelectionLoad); elements.matrixKitEnd.addEventListener("input", scheduleMatrixSelectionLoad); elements.matrixKitExtra.addEventListener("input", scheduleMatrixSelectionLoad);
elements.matrixKitClear.addEventListener("click", () => { elements.matrixKitStart.value = ""; elements.matrixKitEnd.value = ""; elements.matrixKitExtra.value = ""; state.matrixDefaultApplied = true; scheduleMatrixSelectionLoad(); });
elements.matrixProductSelect.addEventListener("change", renderMatrix);
elements.matrixProductSearch.addEventListener("input", renderMatrix); elements.matrixParameterSearch.addEventListener("input", renderMatrix);
elements.matrixModalClose.addEventListener("click", closeMatrixModal); document.querySelectorAll("[data-matrix-close]").forEach((button) => button.addEventListener("click", closeMatrixModal));
document.addEventListener("keydown", (event) => { if (event.key === "Escape" && !elements.matrixModal.hidden) closeMatrixModal(); });
document.addEventListener("visibilitychange", () => { if (!document.hidden && state.activeRun) pollActiveRun(); });
showRootScreen("login");
