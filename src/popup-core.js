let pageContext = null;

function isFirefoxBrowser() {
  return typeof browser !== "undefined" && typeof browser.runtime?.getBrowserInfo === "function";
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

function renderPageHeader(title, description) {
  document.getElementById("pageTitle").textContent = title;
  document.getElementById("pageDescription").textContent = description;
}

function fillSelect(select, values, placeholder, valueKey = null) {
  select.replaceChildren();
  const empty = document.createElement("option");
  empty.value = "";
  empty.textContent = placeholder;
  select.appendChild(empty);
  const items = valueKey ? values : [...values].sort();
  for (const value of items) {
    const opt = document.createElement("option");
    if (valueKey && value && typeof value === "object") {
      opt.value = value[valueKey];
      opt.textContent = value.name || value[valueKey];
    } else {
      opt.value = value;
      opt.textContent = value;
    }
    select.appendChild(opt);
  }
}

async function downloadCsv(filename, columns, rows) {
  if (!rows.length) return;
  const escape = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = [columns.map((c) => c.label).join(",")];
  rows.forEach((row) => {
    lines.push(columns.map(({ key }) => escape(row[key])).join(","));
  });
  await sendMsg({ type: "DOWNLOAD_CSV", filename, content: lines.join("\n") });
}

function parseCsvLine(line) {
  const values = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (char === "," && !inQuotes) {
      values.push(current);
      current = "";
      continue;
    }
    current += char;
  }

  values.push(current);
  return values;
}

function parseCsv(text, columns) {
  const lines = text
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .filter((line) => line.trim());

  if (lines.length < 2) return [];

  const headers = parseCsvLine(lines[0]).map((header) => header.trim());
  const headerToKey = {};
  columns.forEach(({ key, label }) => {
    headerToKey[label.toLowerCase()] = key;
    headerToKey[key.toLowerCase()] = key;
  });

  const mappedIndexes = headers.map((header) => headerToKey[header.toLowerCase()] || null);

  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    const row = {};
    mappedIndexes.forEach((key, index) => {
      if (!key) return;
      row[key] = values[index] ?? "";
    });
    return row;
  });
}

function renderResultsTable(tableId, exportButtonId, columns, rows, normalizeRow) {
  const table = document.getElementById(tableId);
  const exportButton = document.getElementById(exportButtonId);
  table.replaceChildren();

  if (!rows.length) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.textContent = "No results.";
    tr.appendChild(td);
    table.appendChild(tr);
    exportButton.hidden = true;
    return [];
  }

  exportButton.hidden = false;
  const normalized = normalizeRow ? rows.map(normalizeRow) : rows;

  const headerRow = document.createElement("tr");
  columns.forEach(({ label }) => {
    const th = document.createElement("th");
    th.textContent = label;
    headerRow.appendChild(th);
  });
  table.appendChild(headerRow);

  normalized.forEach((row) => {
    const tr = document.createElement("tr");
    columns.forEach(({ key }) => {
      const td = document.createElement("td");
      td.textContent = row[key];
      tr.appendChild(td);
    });
    table.appendChild(tr);
  });

  return normalized;
}

function getPageContext() {
  return pageContext;
}

function setPageContext(ctx) {
  pageContext = ctx;
}

function watchActiveTab(refreshPageContext) {
  const onTabChange = () => {
    refreshPageContext().catch((err) => {
      renderPageHeader("", err.message);
      POPUP_FEATURES.forEach((feature) => feature.setActive(false, null));
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

function wireHelpLink() {
  document.getElementById("helpLink").addEventListener("click", (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: chrome.runtime.getURL("help.html") });
  });
}

function initPopupShell() {
  document.getElementById("version").textContent = chrome.runtime.getManifest().version;
  wireHelpLink();
}

function getActivePopupFeature() {
  return POPUP_FEATURES.find((feature) => feature.id === pageContext?.feature) || null;
}

async function refreshPageContext() {
  pageContext = await sendMsg({ type: "GET_PAGE_CONTEXT" });
  const active = getActivePopupFeature();
  const description = active
    ? active.getDescription(pageContext.route)
    : pageContext.route?.description || NO_TOOLS_DESCRIPTION;

  renderPageHeader(pageContext.tabTitle || "", description);

  for (const feature of POPUP_FEATURES) {
    await feature.setActive(feature.id === pageContext.feature, pageContext);
  }

  return pageContext;
}

async function initPopup() {
  initPopupShell();
  POPUP_FEATURES.forEach((feature) => feature.init());
  watchActiveTab(refreshPageContext);
  try {
    await refreshPageContext();
  } catch (err) {
    renderPageHeader(pageContext?.tabTitle || "", err.message);
    POPUP_FEATURES.forEach((feature) => feature.setActive(false, null));
  }
}
