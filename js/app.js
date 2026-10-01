"use strict";

const CONFIG = Object.freeze({
  owner: "dnjs3", repository: "dlslrhdwn", branch: "main", apiVersion: "2022-11-28",
  maxFileSize: 20 * 1024 * 1024, rawDirectory: "data/raw", indexPath: "data/processed/index.json",
  analysisHistoryPath: "data/history/analysis-history.json", updateHistoryPath: "data/history/update-history.json", pollInterval: 3500,
});

const state = {
  token: null, selectedUpload: null, files: [], analysisHistory: [], updateHistory: [], selectedFileId: null,
  workbook: null, selectedSheetId: null, currentPage: 1, activeRun: null, pollTimer: null, elapsedTimer: null,
  accessOpen: false, authenticationPending: false, authenticationTimer: null,
  authenticationRequestId: 0, authenticationController: null,
};

const ids = [
  "login-screen", "app-screen", "login-form", "token-input", "token-panel", "login-status", "lock-button",
  "access-control", "logout-button", "refresh-button", "mobile-menu-button", "view-eyebrow", "view-title",
  "run-progress", "progress-status", "progress-file", "progress-elapsed", "progress-message", "progress-percent", "progress-bar",
  "progress-steps", "progress-actions", "progress-retry", "file-input", "file-dropzone", "file-label", "upload-button",
  "upload-message", "file-list", "file-count", "empty-view", "processing-view", "error-view", "analysis-error-message",
  "table-view", "selected-file-name", "selected-file-meta", "sheet-select", "sheet-summary", "page-summary", "table-loading",
  "table-container", "previous-page", "next-page", "current-page", "connection-label", "dashboard-history", "dashboard-update",
  "history-total", "history-success", "history-failure", "history-average", "history-body", "updates-timeline",
];
const elements = Object.fromEntries(ids.map((id) => [id.replace(/-([a-z])/g, (_, c) => c.toUpperCase()), document.getElementById(id)]));
const viewMeta = { dashboard: ["OVERVIEW", "Dashboard"], excel: ["DATA", "Excel 보관함"], history: ["DATA", "분석 History"], updates: ["SYSTEM", "업데이트 사항"] };

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
  state.accessOpen = open; elements.lockButton.setAttribute("aria-expanded", String(open)); elements.tokenPanel.hidden = !open;
  if (!open) { cancelAuthenticationAttempt(); elements.tokenInput.value = ""; elements.loginStatus.textContent = ""; }
  else requestAnimationFrame(() => elements.tokenInput.focus());
}
async function authenticateCandidate(token) {
  if (!token || state.authenticationPending) return;
  const requestId = ++state.authenticationRequestId; const controller = new AbortController(); state.authenticationController = controller; state.authenticationPending = true;
  elements.tokenPanel.setAttribute("aria-busy", "true"); elements.loginStatus.textContent = "접근 권한을 확인하고 있습니다.";
  try {
    const repository = await verifyAccess(token, controller.signal); if (requestId !== state.authenticationRequestId) return;
    state.token = token; elements.tokenInput.value = ""; elements.connectionLabel.textContent = repository.full_name; elements.loginStatus.textContent = "인증되었습니다.";
    showRootScreen("app"); showView("dashboard"); showContentView("empty"); await loadAllData({ preserveSelection: false });
  } catch (error) {
    if (error.name === "AbortError" || requestId !== state.authenticationRequestId) return;
    if ([401, 403, 404].includes(error.status)) { window.location.assign("bookmarks.html"); return; }
    state.token = null; elements.tokenInput.value = ""; elements.loginStatus.textContent = "인증하지 못했습니다."; elements.tokenInput.focus();
  } finally {
    if (requestId === state.authenticationRequestId) { state.authenticationPending = false; state.authenticationController = null; elements.tokenPanel.removeAttribute("aria-busy"); }
  }
}

function showView(name) {
  const meta = viewMeta[name] || viewMeta.dashboard;
  document.querySelectorAll(".app-view").forEach((view) => { view.hidden = view.id !== `${name}-view`; });
  document.querySelectorAll("[data-view]").forEach((button) => button.classList.toggle("active", button.dataset.view === name));
  elements.viewEyebrow.textContent = meta[0]; elements.viewTitle.textContent = meta[1];
  elements.appScreen.classList.remove("menu-open");
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
  clearRunTimers(); cancelAuthenticationAttempt(); Object.assign(state, { token: null, selectedUpload: null, files: [], analysisHistory: [], updateHistory: [], selectedFileId: null, workbook: null, selectedSheetId: null, currentPage: 1, activeRun: null });
  elements.tokenInput.value = ""; elements.fileInput.value = ""; elements.fileLabel.textContent = "파일 선택";
  elements.uploadButton.disabled = true; elements.uploadMessage.textContent = ""; elements.runProgress.hidden = true; elements.tableContainer.replaceChildren();
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
    size: raw.size, status: item?.status || "processing", error: item?.error || null, raw_path: raw.path,
    workbook_path: item?.workbook_path || null, sheet_count: item?.sheet_count || 0, row_count: item?.row_count || 0,
  }; }).sort((a, b) => String(b.uploaded_at || b.id).localeCompare(String(a.uploaded_at || a.id)));
}

async function loadAllData({ preserveSelection = true } = {}) {
  elements.refreshButton.disabled = true;
  try {
    const [rawFiles, processed, history, updates] = await Promise.all([
      getRawFiles(), getOptionalJson(CONFIG.indexPath, { files: [] }), getOptionalJson(CONFIG.analysisHistoryPath, []), getOptionalJson(CONFIG.updateHistoryPath, []),
    ]);
    state.files = mergeFileLists(rawFiles, processed); state.analysisHistory = Array.isArray(history) ? history : history.runs || [];
    state.updateHistory = Array.isArray(updates) ? updates : updates.releases || updates.updates || [];
    renderFileList(); renderDashboard(); renderHistory(); renderUpdates();
    if (preserveSelection && state.selectedFileId) { const selected = state.files.find((file) => file.id === state.selectedFileId); if (selected) await selectFile(selected.id); }
  } catch (error) {
    if (state.token) { elements.uploadMessage.className = "upload-message error"; elements.uploadMessage.textContent = error.message; }
  } finally { elements.refreshButton.disabled = false; }
}

function statusLabel(status) { return status === "ready" || status === "success" ? "완료" : status === "error" || status === "failure" ? "실패" : "분석 중"; }
function makeActivity(item, demo = false) {
  const row = document.createElement("div"); row.className = "activity-item"; const mark = document.createElement("i"); mark.className = item.status === "failure" ? "error-dot" : "success-dot";
  const copy = document.createElement("div"); const strong = document.createElement("strong"); strong.textContent = item.original_name || item.file_name || "Excel 분석";
  const small = document.createElement("small"); small.textContent = `${formatDate(item.completed_at || item.ended_at)} · ${formatSeconds(item.total_seconds)}${demo ? " · DEMO" : ""}`;
  copy.append(strong, small); row.append(mark, copy); return row;
}
function renderDashboard() {
  elements.dashboardHistory.replaceChildren(); const runs = state.analysisHistory.slice(0, 4);
  if (runs.length) runs.forEach((run) => elements.dashboardHistory.append(makeActivity(run)));
  else [
    { original_name: "CKM_measurement_0929.xlsx", completed_at: "2026-09-29T09:10:00+09:00", total_seconds: 17.8, status: "success" },
    { original_name: "CKM_report_0927.xlsx", completed_at: "2026-09-27T13:20:00+09:00", total_seconds: 20.1, status: "success" },
  ].forEach((run) => elements.dashboardHistory.append(makeActivity(run, true)));
  elements.dashboardUpdate.replaceChildren(); const update = state.updateHistory[0];
  const title = document.createElement("strong"); title.textContent = update?.title || "실시간 분석 진행률";
  const body = document.createElement("p"); body.textContent = update?.summary || "업로드 후 진행 단계와 소요 시간을 확인합니다.";
  const meta = document.createElement("small"); meta.textContent = update ? formatUpdateDate(update.released_at || update.date) : "2026. 09. 30.";
  elements.dashboardUpdate.append(title, body, meta);
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
function renderUpdates() {
  elements.updatesTimeline.replaceChildren(); const updates = state.updateHistory.length ? state.updateHistory : [{ date: "2026-09-30", title: "대시보드 개편", summary: "업데이트 기록 파일을 연결하면 이곳에 실제 변경 내역이 표시됩니다.", changes: ["분석 진행률", "자동 표 열기", "History 화면"] }];
  updates.forEach((update) => { const card = document.createElement("article"); card.className = "update-card panel"; const date = document.createElement("time"); date.textContent = `${formatUpdateDate(update.released_at || update.date)} - ${update.title || "업데이트 사항"}`;
    const title = document.createElement("h3"); title.textContent = "업데이트 사항"; const summary = document.createElement("p"); summary.textContent = update.summary || "";
    const list = document.createElement("ul"); (update.changes || []).forEach((change) => { const item = document.createElement("li"); item.textContent = change; list.append(item); }); card.append(date, title, summary, list); elements.updatesTimeline.append(card); });
}
function renderFileList() {
  elements.fileCount.textContent = String(state.files.length); elements.fileList.replaceChildren();
  if (!state.files.length) { const empty = document.createElement("p"); empty.className = "empty-copy"; empty.textContent = "저장된 Excel이 없습니다."; elements.fileList.append(empty); return; }
  state.files.forEach((file) => { const button = document.createElement("button"); button.type = "button"; button.className = `file-item${file.id === state.selectedFileId ? " selected" : ""}`;
    const name = document.createElement("strong"); name.textContent = file.original_name; const status = document.createElement("span"); status.className = `status ${file.status}`; status.textContent = statusLabel(file.status);
    const detail = document.createElement("small"); detail.textContent = `${formatBytes(file.size)} · ${formatDate(file.uploaded_at)}`; button.append(name, status, detail); button.addEventListener("click", () => selectFile(file.id)); elements.fileList.append(button); });
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

function validateUpload(file) { if (!file) return "Excel 파일을 선택하세요."; if (!file.name.toLowerCase().endsWith(".xlsx")) return ".xlsx 파일만 업로드할 수 있습니다."; if (file.size > CONFIG.maxFileSize) return "파일 크기는 20MB 이하여야 합니다."; if (!file.size) return "비어 있는 파일은 업로드할 수 없습니다."; return null; }
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

async function refreshEverything() { await loadAllData(); if (state.activeRun) pollActiveRun(); }
document.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", () => showView(button.dataset.view)));
document.querySelectorAll("[data-go-view]").forEach((button) => button.addEventListener("click", () => showView(button.dataset.goView)));
elements.mobileMenuButton.addEventListener("click", () => elements.appScreen.classList.toggle("menu-open"));
elements.loginForm.addEventListener("submit", (event) => {
  event.preventDefault();
  authenticateCandidate(elements.tokenInput.value.trim());
});
elements.lockButton.addEventListener("click", () => setAccessOpen(!state.accessOpen));
elements.tokenInput.addEventListener("input", () => { elements.loginStatus.textContent = ""; });
elements.tokenInput.addEventListener("keydown", (event) => { if (event.key === "Escape") setAccessOpen(false); });
elements.logoutButton.addEventListener("click", () => { resetState(); showRootScreen("login"); });
elements.refreshButton.addEventListener("click", refreshEverything);
elements.progressRetry.addEventListener("click", async () => { elements.progressActions.hidden = true; await loadAllData({ preserveSelection: false }); const target = state.files.find((file) => file.status === "ready"); if (target) { showView("excel"); await selectFile(target.id); elements.runProgress.hidden = true; } else elements.progressActions.hidden = false; });
elements.fileInput.addEventListener("change", () => chooseUpload(elements.fileInput.files[0])); elements.uploadButton.addEventListener("click", uploadSelectedFile);
elements.fileDropzone.addEventListener("dragover", (event) => { event.preventDefault(); elements.fileDropzone.classList.add("dragging"); }); elements.fileDropzone.addEventListener("dragleave", () => elements.fileDropzone.classList.remove("dragging"));
elements.fileDropzone.addEventListener("drop", (event) => { event.preventDefault(); elements.fileDropzone.classList.remove("dragging"); chooseUpload(event.dataTransfer.files[0]); });
elements.sheetSelect.addEventListener("change", async () => { state.selectedSheetId = elements.sheetSelect.value; state.currentPage = 1; await loadTablePage(); });
elements.previousPage.addEventListener("click", async () => { if (state.currentPage > 1) { state.currentPage -= 1; await loadTablePage(); } }); elements.nextPage.addEventListener("click", async () => { const sheet = selectedSheet(); if (sheet && state.currentPage < sheet.page_count) { state.currentPage += 1; await loadTablePage(); } });
document.addEventListener("visibilitychange", () => { if (!document.hidden && state.activeRun) pollActiveRun(); });
showRootScreen("login");
