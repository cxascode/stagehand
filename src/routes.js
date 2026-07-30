// URL → feature routing. Genesys Cloud admin is a hash-router SPA under
// apps.<region>; match on url.hash (e.g. #/admin/troubleshooting/auditviewer).

const NO_TOOLS_DESCRIPTION = "No tools available here yet.";
const HELP_NOTE =
  "Note: tools appear in the extension when you open the matching page in Genesys Cloud.";

// Genesys admin SPA shell path before the hash route (usually /directory).
const GENESYS_APP_SHELL = "/directory";

const PAGE_ROUTES = [
  {
    feature: "auditQuery",
    hashPrefix: "#/admin/troubleshooting/auditviewer",
    title: "Audit Viewer",
    description: "Allows searching historical audit log up to 1 year prior."
  }
];

const AUDIT_VIEWER_HASH = PAGE_ROUTES[0].hashPrefix;

function buildRouteUrl(appsOrigin, route) {
  const shell = route.shell || GENESYS_APP_SHELL;
  return `${appsOrigin}${shell}${route.hashPrefix}`;
}

function isGenesysAppsHost(hostname) {
  return typeof hostname === "string" && hostname.startsWith("apps.");
}

function resolvePageContext(urlString) {
  if (!urlString) {
    return {
      feature: null,
      reason: "no-tab",
      message: "Couldn't read the active tab. Click into a browser tab and try again."
    };
  }

  let url;
  try {
    url = new URL(urlString);
  } catch {
    return {
      feature: null,
      reason: "bad-url",
      message: "Active tab doesn't have a readable URL."
    };
  }

  if (!isGenesysAppsHost(url.hostname)) {
    return {
      feature: null,
      reason: "not-genesys",
      hostname: url.hostname,
      hash: url.hash || "",
      message:
        "Open Genesys Cloud admin and go to Audit Viewer (Admin → Troubleshooting → Audit Viewer)."
    };
  }

  const hash = url.hash || "";
  for (const route of PAGE_ROUTES) {
    if (hash.startsWith(route.hashPrefix)) {
      return {
        feature: route.feature,
        route,
        hostname: url.hostname,
        hash,
        message: null
      };
    }
  }

  return {
    feature: null,
    reason: "unsupported-route",
    hostname: url.hostname,
    hash,
    message:
      "No stagehand tools for this page. Open Audit Viewer to run historical audit queries.",
    suggestedHash: AUDIT_VIEWER_HASH
  };
}
