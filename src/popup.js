let lastResults = [];
let serviceMapping = { services: [] };
let pollTimer = null;
let pageContext = null;
let auditUiReady = false;

const RESULT_COLUMNS = [
  { key: "serviceName", label: "Service Name" },
  { key: "entity", label: "Entity" },
  { key: "entityType", label: "Entity Type" },
  { key: "action", label: "Action" },
  { key: "user", label: "User" },
  { key: "dateTime", label: "Date and Time" }
];

function extractEntity(entity) {
  if (!entity) return "";
  if (typeof entity === "string") return entity;
  return entity.name || entity.id || "";
}

function extractUser(user) {
  if (!user) return "";
  if (typeof user === "string") return user;
  return user.id || user.name || "";
}

function formatEventDate(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true
  });
}

function normalizeAuditRow(row) {
  return {
    serviceName: row.serviceName || "",
    entity: extractEntity(row.entity),
    entityType: row.entityType || "",
    action: row.action || "",
    user: extractUser(row.user),
    dateTime: formatEventDate(row.eventDate)
  };
}

function normalizeAuditRows(rows) {
  return rows.map(normalizeAuditRow);
}

function clearStatus() {
  const el = document.getElementById("status");
  el.replaceChildren();
  el.style.color = "";
}

function setError(msg) {
  const el = document.getElementById("status");
  el.textContent = msg;
  el.style.color = "#a00";
}

function setJobStatus(msg) {
  const el = document.getElementById("status");
  el.style.color = "#555";
  el.replaceChildren();
  const label = document.createElement("strong");
  label.textContent = "Status:";
  el.append(label, " ", msg);
}

let lastLoggedServiceCount = -1;
let lastLoggedQueryStateKey = "";

function logServicesLoaded() {
  const count = serviceMapping.services.length;
  if (!count || count === lastLoggedServiceCount) return;
  lastLoggedServiceCount = count;
  console.log(`stagehand: loaded ${count} services`);
}

function logQueryState(state) {
  if (!state || state.status === "idle") return;
  const key = [
    state.status,
    state.transactionId || "",
    state.serverState || "",
    state.chunkIndex ?? "",
    state.message || ""
  ].join("|");
  if (key === lastLoggedQueryStateKey) return;
  lastLoggedQueryStateKey = key;
  console.log("stagehand: query state", {
    status: state.status,
    transactionId: state.transactionId || null,
    serverState: state.serverState || null,
    chunkIndex: state.chunkIndex ?? null,
    chunkCount: state.chunkCount ?? null,
    message: state.message || null
  });
}

function sendMsg(msg) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (resp) => {
      if (chrome.runtime.lastError) {
        return reject(new Error(chrome.runtime.lastError.message));
      }
      if (!resp) return reject(new Error("No response from background."));
      if (resp.error) return reject(new Error(resp.error));
      resolve(resp);
    });
  });
}

function fillSelect(select, values, placeholder) {
  select.replaceChildren();
  const empty = document.createElement("option");
  empty.value = "";
  empty.textContent = placeholder;
  select.appendChild(empty);
  for (const value of values.sort()) {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = value;
    select.appendChild(opt);
  }
}

function onServiceChange() {
  const serviceName = document.getElementById("serviceName").value;
  const entitySelect = document.getElementById("entityType");
  const actionSelect = document.getElementById("action");

  const service = serviceMapping.services.find((s) => s.name === serviceName);
  const entities = service ? service.entities.map((e) => e.name) : [];

  fillSelect(entitySelect, entities, "Any");
  entitySelect.disabled = !serviceName;

  fillSelect(actionSelect, [], "Any");
  actionSelect.disabled = true;
}

function onEntityChange() {
  const serviceName = document.getElementById("serviceName").value;
  const entityName = document.getElementById("entityType").value;
  const actionSelect = document.getElementById("action");

  const service = serviceMapping.services.find((s) => s.name === serviceName);
  const entity = service?.entities.find((e) => e.name === entityName);
  const actions = entity ? entity.actions : [];

  fillSelect(actionSelect, actions, "Any");
  actionSelect.disabled = !entityName;
}

function buildFilters() {
  const filters = [];
  const entityType = document.getElementById("entityType").value;
  const action = document.getElementById("action").value;
  if (entityType) filters.push({ property: "EntityType", value: entityType });
  if (action) filters.push({ property: "Action", value: action });
  return filters;
}

const DEFAULT_RANGE_DAYS = 30;

function toDatetimeLocalMidnight(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T00:00`;
}

function defaultDateRange() {
  const end = new Date();
  end.setHours(0, 0, 0, 0);
  const start = new Date(end);
  start.setDate(start.getDate() - DEFAULT_RANGE_DAYS);
  return {
    start: toDatetimeLocalMidnight(start),
    end: toDatetimeLocalMidnight(end)
  };
}

function applyDefaultDateRange() {
  const { start, end } = defaultDateRange();
  document.getElementById("start").value = start;
  document.getElementById("end").value = end;
}

function normalizeDateInputToMidnight(inputEl) {
  if (!inputEl.value) return;
  const datePart = inputEl.value.split("T")[0];
  if (!datePart) return;
  inputEl.value = `${datePart}T00:00`;
}

async function saveFormState() {
  await chrome.storage.session.set({
    popupFormState: {
      serviceName: document.getElementById("serviceName").value,
      entityType: document.getElementById("entityType").value,
      action: document.getElementById("action").value,
      start: document.getElementById("start").value,
      end: document.getElementById("end").value
    }
  });
}

async function restoreFormState() {
  const { popupFormState } = await chrome.storage.session.get("popupFormState");
  if (!popupFormState) {
    applyDefaultDateRange();
    return;
  }

  document.getElementById("serviceName").value = popupFormState.serviceName || "";
  onServiceChange();
  document.getElementById("entityType").value = popupFormState.entityType || "";
  onEntityChange();
  document.getElementById("action").value = popupFormState.action || "";
  document.getElementById("start").value = popupFormState.start || "";
  document.getElementById("end").value = popupFormState.end || "";
}

function showAuditPanel(show) {
  document.getElementById("auditQueryPanel").hidden = !show;
}

function renderPageHeader(title, description) {
  document.getElementById("pageTitle").textContent = title;
  document.getElementById("pageDescription").textContent = description;
}

async function ensureAuditUiReady() {
  if (auditUiReady) return;
  await loadServiceMapping();
  await restoreFormState();
  auditUiReady = true;
}

async function refreshPageContext() {
  pageContext = await sendMsg({ type: "GET_PAGE_CONTEXT" });

  const description =
    pageContext.feature === "auditQuery"
      ? pageContext.route?.description || ""
      : NO_TOOLS_DESCRIPTION;
  renderPageHeader(pageContext.tabTitle || "", description);

  if (pageContext.feature === "auditQuery") {
    showAuditPanel(true);
    document.getElementById("runningAwayNote").classList.remove("visible");
    await ensureAuditUiReady();

    const state = await refreshQueryState();
    if (state.status === "running") {
      startPolling();
    } else {
      clearStatus();
    }
    return pageContext;
  }

  showAuditPanel(false);

  const state = await sendMsg({ type: "GET_QUERY_STATE" });
  const awayNote = document.getElementById("runningAwayNote");
  if (state.status === "running") {
    awayNote.classList.add("visible");
    startPolling();
  } else {
    awayNote.classList.remove("visible");
    stopPolling();
  }

  return pageContext;
}

function watchActiveTab() {
  const onTabChange = () => {
    refreshPageContext().catch((err) => {
      renderPageHeader("", err.message);
      showAuditPanel(false);
    });
  };

  chrome.tabs.onActivated.addListener(onTabChange);
  chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
    if (changeInfo.url || changeInfo.title || changeInfo.status === "complete") onTabChange();
  });
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "ROUTE_CHANGED") onTabChange();
  });
}

function setQueryRunning(running) {
  document.getElementById("run").disabled = running;
  document.getElementById("queryNote").classList.toggle("visible", running);
}

function resetFormUI() {
  document.getElementById("serviceName").value = "";
  onServiceChange();
  applyDefaultDateRange();
}

function setExportVisible(visible) {
  document.getElementById("exportCsv").hidden = !visible;
}

function clearResults() {
  lastResults = [];
  document.getElementById("resultsTable").replaceChildren();
  setExportVisible(false);
}

async function clearAll() {
  const state = await sendMsg({ type: "GET_QUERY_STATE" });
  if (state.status === "running") {
    setError("Query still running on Genesys — cannot clear until it finishes.");
    return;
  }

  stopPolling();
  clearResults();
  resetFormUI();
  await chrome.storage.session.remove("popupFormState");
  await chrome.storage.session.set({ queryState: { status: "idle" } });
  setQueryRunning(false);
  lastLoggedQueryStateKey = "";
  logServicesLoaded();
  clearStatus();
}

function applyQueryState(state) {
  if (!state || state.status === "idle") return;
  if (pageContext?.feature !== "auditQuery") return;

  logQueryState(state);

  if (state.status === "running") {
    setQueryRunning(true);
    setJobStatus(state.message);
    return;
  }

  setQueryRunning(false);

  if (state.status === "done") {
    lastResults = state.results || [];
    renderTable(lastResults);
    setJobStatus(state.message);
  }

  if (state.status === "error") {
    if (state.results?.length) {
      lastResults = state.results;
      renderTable(lastResults);
    }
    setError(state.message);
  }
}

async function refreshQueryState() {
  const state = await sendMsg({ type: "GET_QUERY_STATE" });
  applyQueryState(state);
  if (state.status !== "running") stopPolling();
  return state;
}

function startPolling() {
  stopPolling();
  pollTimer = setInterval(() => {
    refreshQueryState().catch((err) => setError(err.message));
  }, 1000);
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

async function loadServiceMapping() {
  const cached = await chrome.storage.session.get("serviceMapping");
  if (cached.serviceMapping?.services) {
    serviceMapping = cached.serviceMapping;
  }

  try {
    const mapping = await sendMsg({ type: "GET_SERVICE_MAPPING" });
    serviceMapping = mapping.services ? mapping : { services: [] };

    const select = document.getElementById("serviceName");
    fillSelect(
      select,
      serviceMapping.services.map((s) => s.name),
      "Select a service..."
    );
    logServicesLoaded();
  } catch (err) {
    if (!serviceMapping.services.length) throw err;
  }
}

function renderTable(rows) {
  const table = document.getElementById("resultsTable");
  table.replaceChildren();
  if (!rows.length) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.textContent = "No results.";
    tr.appendChild(td);
    table.appendChild(tr);
    setExportVisible(false);
    return;
  }

  setExportVisible(true);

  const normalized = normalizeAuditRows(rows);
  const headerRow = document.createElement("tr");
  RESULT_COLUMNS.forEach(({ label }) => {
    const th = document.createElement("th");
    th.textContent = label;
    headerRow.appendChild(th);
  });
  table.appendChild(headerRow);

  normalized.forEach((row) => {
    const tr = document.createElement("tr");
    RESULT_COLUMNS.forEach(({ key }) => {
      const td = document.createElement("td");
      td.textContent = row[key];
      tr.appendChild(td);
    });
    table.appendChild(tr);
  });
}

function downloadCsv(rows) {
  if (!rows.length) return;
  const normalized = normalizeAuditRows(rows);
  const escape = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = [RESULT_COLUMNS.map((c) => c.label).join(",")];
  normalized.forEach((row) => {
    lines.push(RESULT_COLUMNS.map(({ key }) => escape(row[key])).join(","));
  });
  const blob = new Blob([lines.join("\n")], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  chrome.downloads
    ? chrome.downloads.download({ url, filename: "stagehand_audit_results.csv" })
    : window.open(url);
}

function wireFormPersistence() {
  document.getElementById("action").addEventListener("change", () => saveFormState());
  for (const id of ["start", "end"]) {
    const el = document.getElementById(id);
    el.addEventListener("change", () => {
      normalizeDateInputToMidnight(el);
      saveFormState();
    });
  }
}

document.getElementById("serviceName").addEventListener("change", () => {
  onServiceChange();
  saveFormState();
});
document.getElementById("entityType").addEventListener("change", () => {
  onEntityChange();
  saveFormState();
});

document.getElementById("run").addEventListener("click", async () => {
  if (pageContext?.feature !== "auditQuery") {
    setError("Open Audit Viewer to run queries.");
    return;
  }

  setJobStatus("Starting query...");
  setQueryRunning(true);
  setExportVisible(false);
  clearResults();
  try {
    const serviceName = document.getElementById("serviceName").value;
    if (!serviceName) throw new Error("Select a service name.");

    const startInput = document.getElementById("start").value;
    const endInput = document.getElementById("end").value;
    if (!startInput || !endInput) throw new Error("Pick both a start and end date/time.");

    const payload = {
      serviceName,
      filters: buildFilters(),
      start: new Date(startInput).toISOString(),
      end: new Date(endInput).toISOString()
    };

    await saveFormState();
    await sendMsg({ type: "RUN_AUDIT_QUERY", payload });
    startPolling();
    await refreshQueryState();
  } catch (err) {
    setError(err.message);
    setQueryRunning(false);
  }
});

document.getElementById("exportCsv").addEventListener("click", () => downloadCsv(lastResults));
document.getElementById("helpLink").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: chrome.runtime.getURL("help.html") });
});

document.getElementById("clear").addEventListener("click", () => {
  clearAll().catch((err) => setError(err.message));
});

async function init() {
  document.getElementById("version").textContent = chrome.runtime.getManifest().version;
  wireFormPersistence();
  watchActiveTab();
  try {
    await refreshPageContext();
  } catch (err) {
    renderPageHeader(pageContext?.tabTitle || "", err.message);
    showAuditPanel(false);
  }
}

init();
