// Tokens are cached per-region (apiBase), not as a single global pair.
// Multiple tabs for the SAME region share one token (fine — same origin,
// same session). Multiple tabs across DIFFERENT regions each get their
// own slot, and queries resolve against whichever region the currently
// active tab belongs to.
// Genesys Cloud constraints on the full-history audits endpoint:
// - max ~1 year of retained history
// - max 30 days per query
// This extension only targets historical audits (/api/v2/audits/query) —
// realtime (/query/realtime, last 14 days) is already covered by the
// product's own UI, so it's intentionally not implemented here.
// Chrome MV3 loads deps via importScripts in the service worker; Firefox
// lists the same files in manifest.background.scripts (importScripts is
// not available in non-SW background scripts).
if (typeof importScripts === "function") {
  importScripts("routes.js", "api/client.js", "api/audits.js");
}

const MAX_QUERY_DAYS = 30;
const MAX_HISTORY_DAYS = 365;

// Tokens are cached per-region (apiBase), not as a single global pair.
// Multiple tabs for the SAME region share one token (fine — same origin,
// same session). Multiple tabs across DIFFERENT regions each get their
// own slot, and queries resolve against whichever region the currently
// active tab belongs to.
let tokenStore = {}; // { [apiBase]: { token, expiry } }

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

  if (msg.type === "GET_TOKEN_STATUS") {
    getActiveTabApiBase()
      .then((apiBase) => sendResponse({ apiBase, hasToken: !!tokenStore[apiBase] }))
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (msg.type === "GET_SERVICE_MAPPING") {
    fetchServiceMapping()
      .then(sendResponse)
      .catch(err => sendResponse({ error: err.message }));
    return true; // keep channel open for async response
  }

  if (msg.type === "GET_PAGE_CONTEXT") {
    getActiveTabPageContext()
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (msg.type === "GET_QUERY_STATE") {
    getQueryState()
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (msg.type === "RUN_AUDIT_QUERY") {
    getActiveTabPageContext()
      .then((page) => {
        if (page.feature !== "auditQuery") {
          sendResponse({ error: page.message || "Open Audit Viewer to run queries." });
          return;
        }
        return getQueryState().then((state) => {
          if (state.status === "running") {
            sendResponse({ error: "A query is already running in this browser session." });
            return;
          }
          runAuditQueryChunked(msg.payload).catch(async (err) => {
            const prev = await getQueryState();
            await setQueryState({
              ...prev,
              status: "error",
              message: err.message
            });
          });
          sendResponse({ started: true });
        });
      })
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }
});

async function getQueryState() {
  const stored = await chrome.storage.session.get("queryState");
  return stored.queryState || { status: "idle" };
}

async function setQueryState(state) {
  await chrome.storage.session.set({ queryState: state });
}

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

async function ensureToken() {
  const apiBase = await getActiveTabApiBase();

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

async function fetchServiceMapping() {
  const mapping = await getServiceMapping(authedFetch);
  await chrome.storage.session.set({ serviceMapping: mapping });
  return mapping;
}

// Splits [startISO, endISO) into consecutive chunks no longer than
// MAX_QUERY_DAYS each.
function chunkDateRange(startDate, endDate, maxDays) {
  const chunks = [];
  let chunkStart = new Date(startDate);
  const finalEnd = new Date(endDate);
  const maxMs = maxDays * 24 * 60 * 60 * 1000;

  while (chunkStart < finalEnd) {
    let chunkEnd = new Date(chunkStart.getTime() + maxMs);
    if (chunkEnd > finalEnd) chunkEnd = finalEnd;
    chunks.push([new Date(chunkStart), new Date(chunkEnd)]);
    chunkStart = chunkEnd;
  }
  return chunks;
}

function toIsoNoMs(date) {
  return date.toISOString().split(".")[0];
}

async function runSingleQuery(serviceName, filters, startDate, endDate, hooks = {}) {
  return executeAuditQuery(
    authedFetch,
    {
      interval: `${toIsoNoMs(startDate)}/${toIsoNoMs(endDate)}`,
      serviceName,
      filters
    },
    hooks
  );
}

// Clamps the requested start date to Genesys's retention window, splits
// the (possibly clamped) range into <=30-day chunks, and runs one query
// per chunk sequentially, combining all results. Progress is written to
// chrome.storage.session so the popup can restore state after reopen.
async function runAuditQueryChunked(payload) {
  const { serviceName, filters, start, end } = payload;

  let startDate = new Date(start);
  const endDate = new Date(end);
  const earliestAllowed = new Date(Date.now() - MAX_HISTORY_DAYS * 24 * 60 * 60 * 1000);

  let clamped = false;
  if (startDate < earliestAllowed) {
    startDate = earliestAllowed;
    clamped = true;
  }

  const effectiveStart = toIsoNoMs(startDate);
  const chunks = chunkDateRange(startDate, endDate, MAX_QUERY_DAYS);
  let allResults = [];

  const baseMeta = {
    chunkCount: chunks.length,
    clampedToRetention: clamped,
    effectiveStart
  };

  console.log("stagehand: audit query run started", {
    serviceName,
    start,
    end,
    chunkCount: chunks.length,
    clampedToRetention: clamped,
    effectiveStart,
    filters
  });

  await setQueryState({
    status: "running",
    message: `Running query (${chunks.length} chunk${chunks.length === 1 ? "" : "s"})...`,
    results: [],
    chunkIndex: 0,
    ...baseMeta
  });

  for (let i = 0; i < chunks.length; i++) {
    const [chunkStart, chunkEnd] = chunks[i];
    console.log("stagehand: audit query chunk starting", {
      chunk: i + 1,
      chunkCount: chunks.length,
      chunkStart: toIsoNoMs(chunkStart),
      chunkEnd: toIsoNoMs(chunkEnd)
    });
    await setQueryState({
      status: "running",
      message: `Running chunk ${i + 1} of ${chunks.length}...`,
      results: allResults,
      chunkIndex: i + 1,
      ...baseMeta
    });
    const { results: chunkResults, transactionId } = await runSingleQuery(
      serviceName,
      filters,
      chunkStart,
      chunkEnd,
      {
        onCreated: async ({ transactionId: txId, state }) => {
          const prev = await getQueryState();
          await setQueryState({
            ...prev,
            transactionId: txId,
            serverState: state
          });
        }
      }
    );
    allResults = allResults.concat(chunkResults);
    console.log("stagehand: audit query chunk complete", {
      chunk: i + 1,
      chunkCount: chunks.length,
      transactionId,
      chunkResultCount: chunkResults.length
    });
  }

  let message = `Done. ${allResults.length} result(s).`;
  if (clamped) {
    message += ` Start date was clamped to ${effectiveStart} — Genesys only retains 1 year of audit history.`;
  }

  await setQueryState({
    status: "done",
    message,
    results: allResults,
    chunkIndex: chunks.length,
    ...baseMeta
  });

  return {
    results: allResults,
    chunkCount: chunks.length,
    clampedToRetention: clamped,
    effectiveStart
  };
}
