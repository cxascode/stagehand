// Shared background worker: tokens, page context, action state, feature dispatch.
// Chrome MV3 loads deps via importScripts in the service worker; Firefox lists the
// same files in manifest.background.scripts (importScripts is not available there).
if (typeof importScripts === "function") {
  importScripts(
    "routes.js",
    "api/client.js",
    "api/pagination.js",
    "api/permission-catalog.js",
    "api/audits.js",
    "api/authorization.js",
    "features/audit-background.js",
    "features/roles-background.js"
  );
}

let tokenStore = {}; // { [apiBase]: { token, expiry } }
const messageHandlers = {};

function registerMessageHandler(type, handler) {
  messageHandlers[type] = handler;
}

registerAuditBackgroundHandlers(registerMessageHandler);
registerRolesBackgroundHandlers(registerMessageHandler);

registerMessageHandler("DOWNLOAD_CSV", async (msg, _sender, sendResponse) => {
  const { filename, content } = msg;
  if (!filename || content == null) {
    sendResponse({ error: "Missing filename or content." });
    return;
  }

  const blob = new Blob([content], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  try {
    await chrome.downloads.download({ url, filename });
    sendResponse({ ok: true });
  } catch (err) {
    sendResponse({ error: err.message });
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
});

registerMessageHandler("ROLES_IMPORT_COMPLETE", async (msg, sender, sendResponse) => {
  const message = msg.message || "Import complete.";
  await chrome.storage.session.set({ rolesImportResult: { message, at: Date.now() } });

  if (sender.tab?.id) {
    try {
      await chrome.tabs.remove(sender.tab.id);
    } catch {
      // Tab may already be closed.
    }
  }

  const tabs = await chrome.tabs.query({});
  const rolesTab = tabs.find((tab) => resolvePageContext(tab.url).feature === "roleExport");
  const target = rolesTab || tabs.find((tab) => isGenesysTabUrl(tab.url));
  if (!target?.id) {
    sendResponse({ error: "No Genesys Cloud tab found." });
    return;
  }

  await chrome.tabs.update(target.id, { active: true });
  if (target.windowId != null) {
    await chrome.windows.update(target.windowId, { focused: true });
  }

  try {
    if (chrome.action?.openPopup && target.windowId != null) {
      const contexts =
        typeof chrome.runtime.getContexts === "function"
          ? await chrome.runtime.getContexts({ contextTypes: ["POPUP"] })
          : [];
      if (!contexts.length) {
        await chrome.action.openPopup({ windowId: target.windowId });
        sendResponse({ ok: true, popup: true });
        return;
      }
    }
  } catch (err) {
    console.warn("stagehand: openPopup failed", err.message);
  }

  try {
    await chrome.tabs.sendMessage(target.id, { type: "SHOW_STAGEHAND_TOAST", message });
  } catch {
    // Content script unavailable — result still appears next time the popup opens.
  }

  sendResponse({ ok: true, popup: false });
});

function isGenesysTabUrl(urlString) {
  if (!urlString) return false;
  try {
    return isGenesysAppsHost(new URL(urlString).hostname);
  } catch {
    return false;
  }
}

async function syncActionForTab(tabId, url) {
  if (tabId == null || tabId < 0) return;
  try {
    if (isGenesysTabUrl(url)) {
      await chrome.action.enable(tabId);
    } else {
      await chrome.action.disable(tabId);
    }
  } catch {
    // Tab closed or a restricted URL (e.g. chrome://).
  }
}

async function syncAllTabActions() {
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.map((tab) => syncActionForTab(tab.id, tab.url)));
}

function watchTabActionState() {
  chrome.tabs.onActivated.addListener(async ({ tabId }) => {
    try {
      const tab = await chrome.tabs.get(tabId);
      await syncActionForTab(tabId, tab.url);
    } catch {
      // Tab gone.
    }
  });

  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.url || changeInfo.status === "complete") {
      syncActionForTab(tabId, tab.url);
    }
  });
}

chrome.runtime.onInstalled.addListener(() => {
  syncAllTabActions();
});

chrome.runtime.onStartup.addListener(() => {
  syncAllTabActions();
});

watchTabActionState();
syncAllTabActions();

async function cacheGenesysAppsOrigin(urlString) {
  if (!urlString) return;
  try {
    const url = new URL(urlString);
    if (!isGenesysAppsHost(url.hostname)) return;
    const { genesysAppsOrigin } = await chrome.storage.local.get("genesysAppsOrigin");
    if (genesysAppsOrigin === url.origin) return;
    await chrome.storage.local.set({ genesysAppsOrigin: url.origin });
  } catch {
    // ignore bad URLs
  }
}

async function getActiveTabPageContext() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let url = tab?.url;
  let tabTitle = tab?.title || "";

  if (url) await cacheGenesysAppsOrigin(url);

  if (tab?.id && url) {
    try {
      const hostname = new URL(url).hostname;
      if (isGenesysAppsHost(hostname)) {
        const live = await chrome.tabs.sendMessage(tab.id, { type: "GET_LOCATION" });
        if (live?.title) tabTitle = live.title;
      }
    } catch {
      // Content script not ready — tab.title is fine.
    }
  }

  return { ...resolvePageContext(url), tabTitle };
}

function deriveApiBase(hostname) {
  if (hostname.startsWith("apps.")) {
    return "https://api." + hostname.slice("apps.".length);
  }
  return null;
}

async function getActiveTabApiBase() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url) {
    throw new Error("Couldn't determine the active tab. Click into a Genesys Cloud tab and try again.");
  }
  let hostname;
  try {
    hostname = new URL(tab.url).hostname;
  } catch {
    throw new Error("Active tab doesn't have a readable URL.");
  }
  const apiBase = deriveApiBase(hostname);
  if (!apiBase) {
    throw new Error(
      `The active tab (${hostname}) isn't a Genesys Cloud admin tab. Click into your Genesys Cloud tab, then try again.`
    );
  }
  return apiBase;
}

async function resolveApiBase() {
  try {
    return await getActiveTabApiBase();
  } catch {
    const { genesysAppsOrigin } = await chrome.storage.local.get("genesysAppsOrigin");
    if (!genesysAppsOrigin) {
      throw new Error("Open a Genesys Cloud admin tab once, then try again.");
    }
    const apiBase = deriveApiBase(new URL(genesysAppsOrigin).hostname);
    if (!apiBase) {
      throw new Error("Could not determine Genesys API base from the last admin tab.");
    }
    return apiBase;
  }
}

async function ensureToken() {
  const apiBase = await resolveApiBase();

  if (Object.keys(tokenStore).length === 0) {
    const stored = await chrome.storage.session.get("gcTokenStore");
    tokenStore = stored.gcTokenStore || {};
  }

  const entry = tokenStore[apiBase];
  if (!entry) {
    throw new Error(
      `No token cached for ${apiBase} yet. Make sure that Genesys Cloud tab is fully loaded, then try again.`
    );
  }
  if (entry.expiry && entry.expiry < Date.now()) {
    delete tokenStore[apiBase];
    throw new Error("Token expired. Reload the Genesys Cloud tab and try again.");
  }

  return { token: entry.token, apiBase };
}

async function authedFetch(path, options = {}, hooks = {}) {
  const { token, apiBase } = await ensureToken();
  return platformFetch(apiBase, token, path, options, {
    ...hooks,
    onUnauthorized: () => {
      delete tokenStore[apiBase];
    }
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "TOKEN_FOUND") {
    tokenStore[msg.apiBase] = { token: msg.token, expiry: msg.expiry };
    chrome.storage.session.set({ gcTokenStore: tokenStore });
    return;
  }

  if (msg.type === "TOKEN_NOT_FOUND") {
    console.warn("stagehand: token not found.", msg.reason || "");
    return;
  }

  if (msg.type === "ROUTE_CHANGED") {
    if (sender.tab?.id != null) {
      syncActionForTab(sender.tab.id, msg.href);
    }
    return;
  }

  if (msg.type === "GET_TOKEN_STATUS") {
    getActiveTabApiBase()
      .then((apiBase) => sendResponse({ apiBase, hasToken: !!tokenStore[apiBase] }))
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (msg.type === "GET_PAGE_CONTEXT") {
    getActiveTabPageContext()
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  const handler = messageHandlers[msg.type];
  if (handler) {
    Promise.resolve(handler(msg, sender, sendResponse)).catch((err) => {
      sendResponse({ error: err.message });
    });
    return true;
  }
});
