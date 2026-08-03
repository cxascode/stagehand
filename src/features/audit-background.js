// Audit query feature — background handlers and job runner.

const MAX_QUERY_DAYS = 30;
const MAX_HISTORY_DAYS = 365;
const AUDIT_STATE_KEY = "auditQueryState";

async function getAuditQueryState() {
  const stored = await chrome.storage.session.get(AUDIT_STATE_KEY);
  if (stored[AUDIT_STATE_KEY]) return stored[AUDIT_STATE_KEY];

  // One-time migration from the pre-modular key.
  const legacy = await chrome.storage.session.get("queryState");
  if (legacy.queryState) {
    await chrome.storage.session.set({ [AUDIT_STATE_KEY]: legacy.queryState });
    await chrome.storage.session.remove("queryState");
    return legacy.queryState;
  }

  return { status: "idle" };
}

async function setAuditQueryState(state) {
  await chrome.storage.session.set({ [AUDIT_STATE_KEY]: state });
}

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

async function runSingleAuditQuery(serviceName, filters, startDate, endDate, hooks = {}) {
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
    feature: "auditQuery",
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

  await setAuditQueryState({
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
    await setAuditQueryState({
      status: "running",
      message: `Running chunk ${i + 1} of ${chunks.length}...`,
      results: allResults,
      chunkIndex: i + 1,
      ...baseMeta
    });
    const { results: chunkResults, transactionId } = await runSingleAuditQuery(
      serviceName,
      filters,
      chunkStart,
      chunkEnd,
      {
        onCreated: async ({ transactionId: txId, state }) => {
          const prev = await getAuditQueryState();
          await setAuditQueryState({
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

  await setAuditQueryState({
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

async function fetchServiceMapping() {
  const mapping = await getServiceMapping(authedFetch);
  await chrome.storage.session.set({ serviceMapping: mapping });
  return mapping;
}

function registerAuditBackgroundHandlers(register) {
  register("GET_AUDIT_QUERY_STATE", async (_msg, _sender, sendResponse) => {
    sendResponse(await getAuditQueryState());
  });

  register("GET_SERVICE_MAPPING", async (_msg, _sender, sendResponse) => {
    sendResponse(await fetchServiceMapping());
  });

  register("RUN_AUDIT_QUERY", async (msg, _sender, sendResponse) => {
    const page = await getActiveTabPageContext();
    if (page.feature !== "auditQuery") {
      sendResponse({ error: page.message || "Open Audit Viewer to run queries." });
      return;
    }

    const state = await getAuditQueryState();
    if (state.status === "running") {
      sendResponse({ error: "A query is already running in this browser session." });
      return;
    }

    runAuditQueryChunked(msg.payload).catch(async (err) => {
      const prev = await getAuditQueryState();
      await setAuditQueryState({
        ...prev,
        status: "error",
        message: err.message
      });
    });
    sendResponse({ started: true });
  });
}
