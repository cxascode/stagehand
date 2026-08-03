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
    description: "Search historical audit logs (up to 1 year) and export results to CSV.",
    helpDetail: {
      steps: [
        "Go to Admin → Troubleshooting → Audit Viewer",
        "Open the stagehand popup",
        "Pick Service, optional Entity Type / Action, and a date range",
        "Run Query, then Export CSV when results are ready"
      ],
      notes: [
        "Queries full audit history only — realtime audits (last 14 days) are out of scope; the product UI already covers those.",
        "Genesys allows one historical audit query per organization at a time (org-wide). If another admin is running a query, you must wait for it to finish.",
        "Long date ranges are split into 30-day chunks automatically. Start dates older than one year are clamped."
      ]
    }
  },
  {
    feature: "roleExport",
    hashPrefix: "#/admin/people-permissions/roles",
    altHashPrefixes: ["#/admin/authorization/roles"],
    title: "Roles and Permissions",
    description: "Export and import role permissions as CSV using Genesys UI labels.",
    helpDetail: {
      steps: [
        "Go to Admin → People and Permissions → Roles and Permissions",
        "Open the stagehand popup",
        "Pick a role",
        "Export Permissions, edit Selected in the CSV, then Import Permissions"
      ],
      notes: [
        "CSV columns: Selected, Domain, Entity Name, Action, Conditions. Domain / Entity Name / Action match the role editor Permission column (e.g. ACD Screen Share > Chat > Escalate).",
        "Only edit Selected. Do not rename Domain, Entity Name, or Action.",
        "Conditions is for conditional grants (uncommon). Leave it unchanged — empty means no conditions.",
        "Import replaces the role's full permission set. Export first and keep a backup.",
        "Import shows a diff (+added / −removed / unchanged) before you confirm.",
        "Importing into a different org? Export from the target org first, then apply your selections. Permissions missing in that org can be skipped after explicit confirmation.",
        "Import on default or base roles requires an I accept the risk acknowledgment."
      ]
    }
  }
];

function getRouteByFeature(featureId) {
  return PAGE_ROUTES.find((route) => route.feature === featureId) || null;
}

const AUDIT_VIEWER_HASH = getRouteByFeature("auditQuery")?.hashPrefix || "";
const ROLES_HASH = getRouteByFeature("roleExport")?.hashPrefix || "";

function routeHashMatches(hash, route) {
  if (hash.startsWith(route.hashPrefix)) return true;
  for (const alt of route.altHashPrefixes || []) {
    if (hash.startsWith(alt)) return true;
  }
  return false;
}

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
      message: "Open Genesys Cloud admin in this browser tab to use stagehand."
    };
  }

  const hash = url.hash || "";
  for (const route of PAGE_ROUTES) {
    if (routeHashMatches(hash, route)) {
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
    message: "No stagehand tools for this page yet.",
    suggestedHash: AUDIT_VIEWER_HASH,
    suggestedRoutes: PAGE_ROUTES.map((route) => ({
      title: route.title,
      hashPrefix: route.hashPrefix
    }))
  };
}
