"use strict";

const CONFIG = Object.freeze({
  owner: "dnjs3",
  repository: "dlslrhdwn",
  branch: "main",
  apiVersion: "2022-11-28",
  maxFileSize: 20 * 1024 * 1024,
  rawDirectory: "data/raw",
  indexPath: "data/processed/index.json",
});

const state = {
  token: null,
  selectedUpload: null,
  files: [],
  selectedFileId: null,
  workbook: null,
  selectedSheetId: null,
  currentPage: 1,
};

const elements = Object.fromEntries([
  "login-screen", "failure-screen", "app-screen", "login-form", "token-input",
  "login-button", "login-message", "failure-message", "retry-button", "logout-button",
  "refresh-button", "file-input", "file-dropzone", "file-label", "upload-button",
  "upload-message", "file-list", "file-count", "empty-view", "processing-view",
  "error-view", "analysis-error-message", "table-view", "selected-file-name",
  "selected-file-meta", "sheet-select", "sheet-summary", "page-summary", "table-loading",
  "table-container", "previous-page", "next-page", "current-page", "connection-label",
].map((id) => [id.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()), document.getElementById(id)]));

function showRootScreen(name) {
  elements.loginScreen.hidden = name !== "login";
  elements.failureScreen.hidden = name !== "failure";
  elements.appScreen.hidden = name !== "app";
}

function showContentView(name) {
  elements.emptyView.hidden = name !== "empty";
  elements.processingView.hidden = name !== "processing";
  elements.errorView.hidden = name !== "error";
  elements.tableView.hidden = name !== "table";
}

function apiUrl(path = "") {
  const encodedPath = path.split("/").filter(Boolean).map(encodeURIComponent).join("/");
  const suffix = encodedPath ? `/contents/${encodedPath}` : "";
  return `https://api.github.com/repos/${CONFIG.owner}/${CONFIG.repository}${suffix}`;
}

async function githubRequest(url, options = {}) {
  if (!state.token) throw new Error("인증 정보가 없습니다.");
  const response = await fetch(url, {
    ...options,
    cache: "no-store",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${state.token}`,
      "X-GitHub-Api-Version": CONFIG.apiVersion,
      ...options.headers,
    },
  });
  if (response.status === 401 || response.status === 403) {
    handleExpiredAuthentication(response.status);
    const error = new Error("Token 인증이 만료되었거나 권한이 없습니다.");
    error.status = response.status;
    throw error;
  }
  return response;
}

async function verifyAccess(token) {
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": CONFIG.apiVersion,
  };
  const repositoryResponse = await fetch(
    `https://api.github.com/repos/${CONFIG.owner}/${CONFIG.repository}`,
    { headers, cache: "no-store" },
  );
  if (!repositoryResponse.ok) {
    const error = new Error("비공개 저장소에 접근할 수 없습니다.");
    error.status = repositoryResponse.status;
    throw error;
  }
  const repository = await repositoryResponse.json();
  if (repository.full_name !== `${CONFIG.owner}/${CONFIG.repository}` || !repository.private) {
    throw new Error("지정된 비공개 저장소가 아닙니다.");
  }
  const readResponse = await fetch(apiUrl("README.md"), { headers, cache: "no-store" });
  if (!readResponse.ok) {
    const error = new Error("저장소 파일 읽기 권한이 없습니다.");
    error.status = readResponse.status;
    throw error;
  }
  return repository;
}

function resetState() {
  Object.assign(state, {
    token: null, selectedUpload: null, files: [], selectedFileId: null,
    workbook: null, selectedSheetId: null, currentPage: 1,
  });
  elements.tokenInput.value = "";
  elements.fileInput.value = "";
  elements.fileLabel.textContent = "파일 선택";
  elements.uploadButton.disabled = true;
  elements.uploadMessage.textContent = "";
  elements.tableContainer.replaceChildren();
}

function handleExpiredAuthentication(status) {
  resetState();
  elements.failureMessage.textContent = status === 401
    ? "Token이 만료되었거나 유효하지 않습니다."
    : "Token 권한이 부족하거나 GitHub API 요청이 제한되었습니다.";
  showRootScreen("failure");
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "-";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

function formatDate(value) {
  if (!value) return "날짜 정보 없음";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("ko-KR", {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).format(date);
}

function statusLabel(status) {
  if (status === "ready") return "준비 완료";
  if (status === "error") return "분석 실패";
  return "분석 중";
}

function cellText(value) {
  if (value === null || value === undefined) return "";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

async function getRawJson(path) {
  const response = await githubRequest(apiUrl(path), {
    headers: { Accept: "application/vnd.github.raw+json" },
  });
  if (!response.ok) {
    const error = new Error(`${path} 파일을 불러오지 못했습니다.`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

async function getRawFiles() {
  const response = await githubRequest(apiUrl(CONFIG.rawDirectory));
  if (response.status === 404) return [];
  if (!response.ok) throw new Error("저장된 Excel 목록을 불러오지 못했습니다.");
  const entries = await response.json();
  return entries.filter((entry) => entry.type === "file" && entry.name.toLowerCase().endsWith(".xlsx"));
}

async function getProcessedIndex() {
  try {
    return await getRawJson(CONFIG.indexPath);
  } catch (error) {
    if (error.status === 404) return { files: [] };
    throw error;
  }
}

function mergeFileLists(rawFiles, processedIndex) {
  const processedByPath = new Map((processedIndex.files || []).map((file) => [file.raw_path, file]));
  return rawFiles.map((raw) => {
    const processed = processedByPath.get(raw.path);
    return {
      id: processed?.id || raw.name.replace(/\.xlsx$/i, ""),
      original_name: processed?.original_name || raw.name,
      uploaded_at: processed?.uploaded_at || null,
      size: raw.size,
      status: processed?.status || "processing",
      error: processed?.error || null,
      raw_path: raw.path,
      workbook_path: processed?.workbook_path || null,
      sheet_count: processed?.sheet_count || 0,
    };
  }).sort((a, b) => (b.uploaded_at || b.id).localeCompare(a.uploaded_at || a.id));
}

async function loadFiles({ preserveSelection = true } = {}) {
  elements.refreshButton.disabled = true;
  elements.fileList.innerHTML = '<div class="sidebar-state">목록을 불러오는 중입니다.</div>';
  try {
    const [rawFiles, processedIndex] = await Promise.all([getRawFiles(), getProcessedIndex()]);
    state.files = mergeFileLists(rawFiles, processedIndex);
    renderFileList();
    if (preserveSelection && state.selectedFileId) {
      const selected = state.files.find((file) => file.id === state.selectedFileId);
      if (selected) await selectFile(selected.id);
    }
  } catch (error) {
    if (state.token) elements.fileList.innerHTML = `<div class="sidebar-state">${error.message}</div>`;
  } finally {
    elements.refreshButton.disabled = false;
  }
}

function renderFileList() {
  elements.fileCount.textContent = String(state.files.length);
  elements.fileList.replaceChildren();
  if (!state.files.length) {
    const empty = document.createElement("div");
    empty.className = "sidebar-state";
    empty.textContent = "저장된 Excel이 없습니다. 위에서 첫 파일을 올려보세요.";
    elements.fileList.append(empty);
    showContentView("empty");
    return;
  }
  state.files.forEach((file) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `file-item${file.id === state.selectedFileId ? " selected" : ""}`;
    const name = document.createElement("span");
    name.className = "file-name";
    name.textContent = file.original_name;
    const status = document.createElement("span");
    status.className = `status ${file.status}`;
    status.textContent = statusLabel(file.status);
    const detail = document.createElement("span");
    detail.className = "file-detail";
    detail.textContent = `${formatBytes(file.size)} · ${formatDate(file.uploaded_at)}`;
    button.append(name, status, detail);
    button.addEventListener("click", () => selectFile(file.id));
    elements.fileList.append(button);
  });
}

async function selectFile(fileId) {
  const file = state.files.find((item) => item.id === fileId);
  if (!file) return;
  state.selectedFileId = fileId;
  renderFileList();
  if (file.status === "processing") return showContentView("processing");
  if (file.status === "error") {
    elements.analysisErrorMessage.textContent = file.error || "Excel 처리 중 오류가 발생했습니다.";
    return showContentView("error");
  }
  if (!file.workbook_path) return showContentView("processing");

  showContentView("table");
  elements.tableLoading.hidden = false;
  try {
    state.workbook = await getRawJson(file.workbook_path);
    elements.selectedFileName.textContent = file.original_name;
    elements.selectedFileMeta.textContent = `${formatBytes(file.size)} · ${formatDate(file.uploaded_at)} · ${state.workbook.sheets.length}개 시트`;
    renderSheetOptions();
    const firstSheet = state.workbook.sheets[0];
    if (!firstSheet) throw new Error("표시할 시트가 없습니다.");
    state.selectedSheetId = firstSheet.id;
    state.currentPage = 1;
    elements.sheetSelect.value = firstSheet.id;
    await loadTablePage();
  } catch (error) {
    elements.analysisErrorMessage.textContent = error.message;
    showContentView("error");
  } finally {
    elements.tableLoading.hidden = true;
  }
}

function renderSheetOptions() {
  elements.sheetSelect.replaceChildren();
  state.workbook.sheets.forEach((sheet) => {
    const option = document.createElement("option");
    option.value = sheet.id;
    option.textContent = sheet.name;
    elements.sheetSelect.append(option);
  });
}

function selectedSheet() {
  return state.workbook?.sheets.find((sheet) => sheet.id === state.selectedSheetId) || null;
}

async function loadTablePage() {
  const sheet = selectedSheet();
  if (!sheet) return;
  elements.tableLoading.hidden = false;
  try {
    const pageName = `${sheet.id}-page-${String(state.currentPage).padStart(4, "0")}.json`;
    const page = await getRawJson(`${state.workbook.processed_directory}/${pageName}`);
    renderTable(page);
    elements.sheetSummary.textContent = `${sheet.row_count.toLocaleString("ko-KR")}행 · ${sheet.column_count.toLocaleString("ko-KR")}열`;
    elements.pageSummary.textContent = `${state.currentPage} / ${sheet.page_count} 페이지`;
    elements.currentPage.textContent = `${state.currentPage} / ${sheet.page_count}`;
    elements.previousPage.disabled = state.currentPage <= 1;
    elements.nextPage.disabled = state.currentPage >= sheet.page_count;
  } catch (error) {
    elements.analysisErrorMessage.textContent = error.message;
    showContentView("error");
  } finally {
    elements.tableLoading.hidden = true;
  }
}

function renderTable(page) {
  const table = document.createElement("table");
  table.className = "data-table";
  const head = document.createElement("thead");
  const headerRow = document.createElement("tr");
  const numberHeader = document.createElement("th");
  numberHeader.scope = "col";
  numberHeader.textContent = "#";
  headerRow.append(numberHeader);
  page.columns.forEach((column) => {
    const th = document.createElement("th");
    th.scope = "col";
    th.textContent = cellText(column);
    th.title = cellText(column);
    headerRow.append(th);
  });
  head.append(headerRow);
  const body = document.createElement("tbody");
  page.rows.forEach((row, index) => {
    const tr = document.createElement("tr");
    const number = document.createElement("td");
    number.textContent = String(page.row_offset + index + 2);
    tr.append(number);
    page.columns.forEach((_, columnIndex) => {
      const td = document.createElement("td");
      const value = cellText(row[columnIndex]);
      td.textContent = value;
      td.title = value;
      tr.append(td);
    });
    body.append(tr);
  });
  table.append(head, body);
  elements.tableContainer.replaceChildren(table);
  elements.tableContainer.scrollTo({ top: 0, left: 0 });
}

function validateUpload(file) {
  if (!file) return "Excel 파일을 선택하세요.";
  if (!file.name.toLowerCase().endsWith(".xlsx")) return ".xlsx 파일만 업로드할 수 있습니다.";
  if (file.size > CONFIG.maxFileSize) return "파일 크기는 20MB 이하여야 합니다.";
  if (file.size === 0) return "비어 있는 파일은 업로드할 수 없습니다.";
  return null;
}

function chooseUpload(file) {
  const error = validateUpload(file);
  state.selectedUpload = error ? null : file;
  elements.fileLabel.textContent = file?.name || "파일 선택";
  elements.uploadButton.disabled = Boolean(error);
  elements.uploadMessage.className = `upload-message${error ? " error" : ""}`;
  elements.uploadMessage.textContent = error || `${formatBytes(file.size)} · 업로드할 준비가 되었습니다.`;
}

function safeFilename(filename) {
  const dot = filename.lastIndexOf(".");
  const base = (dot > 0 ? filename.slice(0, dot) : filename).normalize("NFKC")
    .replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "workbook";
  return `${base}.xlsx`;
}

function uploadId() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const random = Array.from(crypto.getRandomValues(new Uint8Array(3)), (value) => value.toString(16).padStart(2, "0")).join("");
  return `${timestamp}_${random}`;
}

function bytesToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

async function uploadSelectedFile() {
  const file = state.selectedUpload;
  const validationError = validateUpload(file);
  if (validationError) return chooseUpload(file);
  elements.uploadButton.disabled = true;
  elements.fileInput.disabled = true;
  elements.uploadMessage.className = "upload-message";
  elements.uploadMessage.textContent = "파일을 준비하고 있습니다.";
  try {
    const path = `${CONFIG.rawDirectory}/${uploadId()}_${safeFilename(file.name)}`;
    const content = bytesToBase64(await file.arrayBuffer());
    elements.uploadMessage.textContent = "비공개 저장소에 업로드하고 있습니다.";
    const response = await githubRequest(apiUrl(path), {
      method: "PUT",
      body: JSON.stringify({ message: `data: upload ${file.name}`, content, branch: CONFIG.branch }),
    });
    if (!response.ok) {
      const details = await response.json().catch(() => ({}));
      throw new Error(details.message || "Excel 업로드에 실패했습니다.");
    }
    state.selectedUpload = null;
    elements.fileInput.value = "";
    elements.fileLabel.textContent = "파일 선택";
    elements.uploadMessage.className = "upload-message success";
    elements.uploadMessage.textContent = "업로드했습니다. 분석이 끝나면 표를 확인할 수 있습니다.";
    await loadFiles({ preserveSelection: false });
  } catch (error) {
    if (state.token) {
      elements.uploadMessage.className = "upload-message error";
      elements.uploadMessage.textContent = error.message;
    }
  } finally {
    elements.fileInput.disabled = false;
    elements.uploadButton.disabled = !state.selectedUpload;
  }
}

elements.loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const token = elements.tokenInput.value.trim();
  if (!token) return void (elements.loginMessage.textContent = "Token을 입력하세요.");
  elements.loginButton.disabled = true;
  elements.loginButton.textContent = "확인 중";
  elements.loginMessage.textContent = "비공개 저장소 접근 권한을 확인하고 있습니다.";
  try {
    const repository = await verifyAccess(token);
    state.token = token;
    elements.tokenInput.value = "";
    elements.connectionLabel.textContent = `${repository.full_name} 연결됨`;
    showRootScreen("app");
    showContentView("empty");
    await loadFiles({ preserveSelection: false });
  } catch (error) {
    state.token = null;
    elements.tokenInput.value = "";
    elements.failureMessage.textContent = error.status === 401
      ? "유효하지 않거나 만료된 Token입니다."
      : "Token이 올바르지 않거나 dlslrhdwn 저장소 권한이 없습니다.";
    showRootScreen("failure");
  } finally {
    elements.loginButton.disabled = false;
    elements.loginButton.textContent = "연결";
    elements.loginMessage.textContent = "";
  }
});

elements.retryButton.addEventListener("click", () => { resetState(); showRootScreen("login"); elements.tokenInput.focus(); });
elements.logoutButton.addEventListener("click", () => { resetState(); showRootScreen("login"); elements.tokenInput.focus(); });
elements.refreshButton.addEventListener("click", () => loadFiles());
elements.fileInput.addEventListener("change", () => chooseUpload(elements.fileInput.files[0]));
elements.uploadButton.addEventListener("click", uploadSelectedFile);
elements.fileDropzone.addEventListener("dragover", (event) => { event.preventDefault(); elements.fileDropzone.classList.add("dragging"); });
elements.fileDropzone.addEventListener("dragleave", () => elements.fileDropzone.classList.remove("dragging"));
elements.fileDropzone.addEventListener("drop", (event) => {
  event.preventDefault();
  elements.fileDropzone.classList.remove("dragging");
  chooseUpload(event.dataTransfer.files[0]);
});
elements.sheetSelect.addEventListener("change", async () => {
  state.selectedSheetId = elements.sheetSelect.value;
  state.currentPage = 1;
  await loadTablePage();
});
elements.previousPage.addEventListener("click", async () => {
  if (state.currentPage > 1) { state.currentPage -= 1; await loadTablePage(); }
});
elements.nextPage.addEventListener("click", async () => {
  const sheet = selectedSheet();
  if (sheet && state.currentPage < sheet.page_count) { state.currentPage += 1; await loadTablePage(); }
});
