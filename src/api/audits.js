// Audit query API — mirrors gc CLI operations (no SDK):
//   servicemapping → create → poll status → page results (cursor)

const AUDIT_POLL_INTERVAL_MS = 1000;

function auditSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getServiceMapping(fetch) {
  return fetch("/api/v2/audits/query/servicemapping");
}

async function createAuditQuery(fetch, payload) {
  return fetch("/api/v2/audits/query", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

async function getAuditQueryStatus(fetch, transactionId) {
  return fetch(`/api/v2/audits/query/${transactionId}`);
}

async function getAuditQueryResultsPage(fetch, transactionId, cursor) {
  const path = cursor
    ? `/api/v2/audits/query/${transactionId}/results?cursor=${encodeURIComponent(cursor)}`
    : `/api/v2/audits/query/${transactionId}/results`;
  return fetch(path);
}

async function getAllAuditQueryResults(fetch, transactionId) {
  let allResults = [];
  let cursor = null;
  do {
    const page = await getAuditQueryResultsPage(fetch, transactionId, cursor);
    allResults = allResults.concat(page.results || page.entities || []);
    cursor = page.cursor || null;
  } while (cursor);
  return allResults;
}

async function waitForAuditQuerySucceeded(fetch, transactionId, initialState) {
  let state = initialState;
  while (state !== "Succeeded") {
    if (state === "Failed") throw new Error("Audit query failed on the server.");
    if (state === "Cancelled") throw new Error("Audit query was cancelled on the server.");
    await auditSleep(AUDIT_POLL_INTERVAL_MS);
    const status = await getAuditQueryStatus(fetch, transactionId);
    if (status.state !== state) {
      console.log("stagehand: audit query status", { transactionId, state: status.state });
    }
    state = status.state;
  }
}

// Create query, poll to completion, fetch all result pages.
async function executeAuditQuery(fetch, payload, hooks = {}) {
  const created = await createAuditQuery(fetch, payload);
  const transactionId = created.id || created.transactionId;
  if (!transactionId) throw new Error("No transaction id returned from query create.");

  console.log("stagehand: audit query created", {
    transactionId,
    state: created.state,
    interval: payload.interval,
    serviceName: payload.serviceName,
    filters: payload.filters
  });
  if (hooks.onCreated) hooks.onCreated({ transactionId, state: created.state });

  await waitForAuditQuerySucceeded(fetch, transactionId, created.state);
  const results = await getAllAuditQueryResults(fetch, transactionId);
  console.log("stagehand: audit query complete", {
    transactionId,
    resultCount: results.length
  });
  return { results, transactionId };
}
