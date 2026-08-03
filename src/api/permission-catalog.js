// Permission catalog from GET /api/v2/authorization/permissions — maps API
// identifiers to the friendly labels shown in the Genesys admin UI.

const PERMISSION_CATALOG_CACHE_KEY = "permissionCatalog";

function humanizeApiName(value) {
  if (!value) return "";
  return value
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function normalizeKey(...parts) {
  return parts
    .map((part) => String(part || "").trim().toLowerCase())
    .join("\0");
}

function buildPermissionCatalog(collections) {
  const byApi = new Map();
  const byFriendly = new Map();
  const entityActions = new Map();
  const entitiesByFriendly = new Map();
  const entitiesByApi = new Map();

  for (const collection of collections || []) {
    const domain = collection.domain || "";
    const category = collection.name || humanizeApiName(domain);
    const permissionMap = collection.permissionMap || {};

    for (const [entityKey, entries] of Object.entries(permissionMap)) {
      const entityName = entityKey;
      const feature = humanizeApiName(entityKey);
      const entity = { domain, entityName, category, feature };
      entitiesByFriendly.set(normalizeKey(category, feature), entity);
      entitiesByApi.set(normalizeKey(domain, entityName), entity);
      entitiesByApi.set(normalizeKey(domain, feature), entity);

      for (const entry of entries || []) {
        const action = entry.action || "";
        const actionLabel = action === "*" ? "All Permissions" : humanizeApiName(action);
        const apiKey = `${domain}\0${entityName}\0${action}`;

        const record = {
          category,
          feature,
          domain,
          entityName,
          action,
          actionLabel
        };

        byApi.set(apiKey, record);
        byFriendly.set(normalizeKey(category, feature, actionLabel), record);
        byFriendly.set(normalizeKey(category, feature, action), record);
        byFriendly.set(normalizeKey(domain, entityName, actionLabel), record);
        byFriendly.set(normalizeKey(domain, entityName, action), record);
        byFriendly.set(normalizeKey(domain, feature, actionLabel), record);

        const entityKey2 = `${domain}\0${entityName}`;
        if (!entityActions.has(entityKey2)) entityActions.set(entityKey2, []);
        entityActions.get(entityKey2).push(record);
      }
    }
  }

  function entityMatches(entity, domainLabel, entityLabel) {
    const domainNeedle = String(domainLabel || "").trim().toLowerCase();
    const entityNeedle = String(entityLabel || "").trim().toLowerCase();
    if (!domainNeedle || !entityNeedle) return false;

    const domainMatch =
      entity.category.toLowerCase() === domainNeedle ||
      entity.domain.toLowerCase() === domainNeedle ||
      humanizeApiName(entity.domain).toLowerCase() === domainNeedle;
    const entityMatch =
      entity.feature.toLowerCase() === entityNeedle ||
      entity.entityName.toLowerCase() === entityNeedle ||
      humanizeApiName(entity.entityName).toLowerCase() === entityNeedle;

    return domainMatch && entityMatch;
  }

  return {
    byApi,
    byFriendly,
    entityActions,
    entitiesByFriendly,
    entitiesByApi,

    listCatalogRows() {
      return [...byApi.values()].sort((a, b) => {
        const left = [a.domain, a.feature, a.actionLabel].join("\0");
        const right = [b.domain, b.feature, b.actionLabel].join("\0");
        return left.localeCompare(right);
      });
    },

    resolveEntity(domainLabel, entityLabel) {
      const exact = entitiesByFriendly.get(normalizeKey(domainLabel, entityLabel));
      if (exact) return exact;

      const apiExact = entitiesByApi.get(normalizeKey(domainLabel, entityLabel));
      if (apiExact) return apiExact;

      for (const entity of entitiesByFriendly.values()) {
        if (entityMatches(entity, domainLabel, entityLabel)) return entity;
      }

      throw new Error(
        `Unknown permission "${domainLabel} > ${entityLabel}". Use values from a stagehand export, or the role editor path (e.g. businessrules > decisionTableExportJob).`
      );
    },

    resolveActionName(entity, actionLabel) {
      const records = entityActions.get(`${entity.domain}\0${entity.entityName}`) || [];
      const normalized = String(actionLabel || "").trim().toLowerCase();

      const match = records.find(
        (entry) =>
          entry.actionLabel.toLowerCase() === normalized ||
          entry.action.toLowerCase() === normalized ||
          (normalized === "all permissions" && entry.action === "*")
      );

      if (!match) {
        throw new Error(
          `Unknown action "${actionLabel}" for ${entity.domain} > ${entity.entityName}. Export a fresh CSV to see valid values.`
        );
      }

      return match.action;
    }
  };
}

async function fetchPermissionCatalog(fetch) {
  const collections = await fetchAllPages(fetch, "/api/v2/authorization/permissions");
  const catalog = buildPermissionCatalog(collections);
  await chrome.storage.session.set({ [PERMISSION_CATALOG_CACHE_KEY]: collections });
  return catalog;
}

let catalogLoadPromise = null;

async function ensurePermissionCatalog(fetch) {
  const cached = await chrome.storage.session.get(PERMISSION_CATALOG_CACHE_KEY);
  if (cached[PERMISSION_CATALOG_CACHE_KEY]?.length) {
    return buildPermissionCatalog(cached[PERMISSION_CATALOG_CACHE_KEY]);
  }

  if (!catalogLoadPromise) {
    catalogLoadPromise = fetchPermissionCatalog(fetch)
      .then((catalog) => {
        console.log(`stagehand: permission catalog cached (${catalog.listCatalogRows().length} permissions)`);
        return catalog;
      })
      .catch((err) => {
        catalogLoadPromise = null;
        throw err;
      });
  }

  return catalogLoadPromise;
}

async function prefetchPermissionCatalog(fetch) {
  return ensurePermissionCatalog(fetch);
}

async function loadPermissionCatalog(fetch) {
  return ensurePermissionCatalog(fetch);
}
