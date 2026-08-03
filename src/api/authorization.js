function grantKey(domain, entityName, action) {
  return `${domain}\0${entityName}\0${action}`;
}

function policyMetaFromGrant(policy) {
  const conditions = policy.resourceConditionNode ? JSON.stringify(policy.resourceConditionNode) : "";
  return { conditions };
}

function rowHasConditions(row) {
  return !!(row.conditions || "").trim();
}

function buildGrantedPermissionMap(role, catalog) {
  const grantedActions = new Map();
  const grantedGeneral = new Set();

  for (const permission of role.permissions || []) {
    grantedGeneral.add(permission);
  }

  for (const policy of role.permissionPolicies || []) {
    const domain = policy.domain || "";
    const entityName = policy.entityName || "";
    const meta = policyMetaFromGrant(policy);
    let actions = policy.actionSet || [];

    if (actions.includes("*")) {
      const records = catalog.entityActions.get(`${domain}\0${entityName}`) || [];
      actions = records.map((record) => record.action);
    }

    for (const action of actions) {
      grantedActions.set(grantKey(domain, entityName, action), meta);
    }
  }

  return { grantedActions, grantedGeneral };
}

function buildFullPermissionMatrix(role, catalog) {
  const { grantedActions, grantedGeneral } = buildGrantedPermissionMap(role, catalog);
  const rows = [];

  for (const record of catalog.listCatalogRows()) {
    const grant = grantedActions.get(grantKey(record.domain, record.entityName, record.action));
    rows.push({
      selected: grant ? "Yes" : "No",
      domain: record.category,
      entityName: record.feature,
      action: record.actionLabel,
      conditions: grant?.conditions || ""
    });
  }

  for (const permission of grantedGeneral) {
    const alreadyListed = rows.some(
      (row) =>
        row.domain === "General" &&
        legacyPermissionLabel(permission).toLowerCase() === row.action.toLowerCase()
    );
    if (alreadyListed) continue;

    rows.push({
      selected: "Yes",
      domain: "General",
      entityName: "",
      action: legacyPermissionLabel(permission),
      conditions: ""
    });
  }

  return rows;
}

function legacyPermissionLabel(permission) {
  return humanizeApiName(permission);
}

function resolveLegacyPermission(actionLabel) {
  return String(actionLabel || "")
    .trim()
    .replace(/\s+/g, "")
    .toLowerCase();
}

function isSelectedYes(row) {
  return String(row.selected ?? row.granted ?? "")
    .trim()
    .toLowerCase() === "yes";
}

function parseConditionsJson(conditions, contextLabel) {
  const trimmed = (conditions || "").trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    throw new Error(`${contextLabel}: Conditions must be valid JSON copied from an export.`);
  }
}

function tryResolveImportRow(row, catalog) {
  if ((row.domain || "").trim().toLowerCase() === "general") {
    if (!(row.action || "").trim()) {
      return { ok: false, error: "General permission is missing Action." };
    }
    return { ok: true, kind: "general" };
  }

  if (!(row.domain || "").trim()) {
    return { ok: false, error: "Domain is required." };
  }
  if (!(row.entityName || "").trim()) {
    return { ok: false, error: "Entity Name is required." };
  }
  if (!(row.action || "").trim()) {
    return { ok: false, error: "Action is required." };
  }

  try {
    const entity = catalog.resolveEntity(row.domain, row.entityName);
    const action = catalog.resolveActionName(entity, row.action);
    return { ok: true, kind: "policy", entity, action };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function importGrantKeyFromResolvedRow(row, resolved) {
  if (resolved.kind === "general") {
    return `general\0${resolveLegacyPermission(row.action)}`;
  }

  const conditions = (row.conditions || "").trim();
  const conditional = conditions ? "1" : "0";
  return `policy\0${resolved.entity.domain}\0${resolved.entity.entityName}\0${resolved.action}\0${conditional}\0${conditions}`;
}

function importGrantLabelFromResolvedRow(row, resolved, catalog) {
  if (resolved.kind === "general") {
    return `General > ${(row.action || "").trim()}`;
  }

  return friendlyPolicyGrantLabel(
    catalog,
    resolved.entity.domain,
    resolved.entity.entityName,
    resolved.action,
    { conditional: rowHasConditions(row) }
  );
}

function importGrantKeyFromRow(row, catalog) {
  const resolved = tryResolveImportRow(row, catalog);
  if (!resolved.ok) throw new Error(resolved.error);
  return importGrantKeyFromResolvedRow(row, resolved);
}

function importGrantLabelFromRow(row, catalog) {
  const resolved = tryResolveImportRow(row, catalog);
  if (!resolved.ok) throw new Error(resolved.error);
  return importGrantLabelFromResolvedRow(row, resolved, catalog);
}

function friendlyPolicyGrantLabel(catalog, domain, entityName, action, meta) {
  const record = catalog.byApi.get(grantKey(domain, entityName, action));
  const parts = [
    record?.category || humanizeApiName(domain),
    record?.feature || humanizeApiName(entityName),
    record?.actionLabel || humanizeApiName(action)
  ];
  let label = parts.filter(Boolean).join(" > ");
  if (meta?.conditional) label += " (conditional)";
  return label;
}

function buildImportGrantSetFromRole(role, catalog) {
  const grants = new Map();
  const { grantedActions, grantedGeneral } = buildGrantedPermissionMap(role, catalog);

  for (const permission of grantedGeneral) {
    grants.set(`general\0${permission.toLowerCase()}`, `General > ${legacyPermissionLabel(permission)}`);
  }

  for (const [apiKey, meta] of grantedActions) {
    const [domain, entityName, action] = apiKey.split("\0");
    const conditional = meta.conditions ? "1" : "0";
    const conditions = meta.conditions || "";
    const key = `policy\0${domain}\0${entityName}\0${action}\0${conditional}\0${conditions}`;
    grants.set(key, friendlyPolicyGrantLabel(catalog, domain, entityName, action, {
      conditional: !!meta.conditions
    }));
  }

  return grants;
}

function buildImportGrantSetFromRows(rows, catalog, options = {}) {
  const { skipUnresolved = false } = options;
  const grants = new Map();

  for (const row of rows) {
    if (!isSelectedYes(row)) continue;

    const resolved = tryResolveImportRow(row, catalog);
    if (!resolved.ok) {
      if (skipUnresolved) continue;
      throw new Error(resolved.error);
    }

    const key = importGrantKeyFromResolvedRow(row, resolved);
    grants.set(key, importGrantLabelFromResolvedRow(row, resolved, catalog));
  }

  return grants;
}

function compareRolePermissionImport(role, rows, catalog, options = {}) {
  const current = buildImportGrantSetFromRole(role, catalog);
  const incoming = buildImportGrantSetFromRows(rows, catalog, options);
  const added = [];
  const removed = [];
  let unchangedCount = 0;

  for (const [key, label] of incoming) {
    if (current.has(key)) unchangedCount++;
    else added.push(label);
  }

  for (const [key, label] of current) {
    if (!incoming.has(key)) removed.push(label);
  }

  added.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  removed.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));

  return {
    added,
    removed,
    addedCount: added.length,
    removedCount: removed.length,
    unchangedCount
  };
}

function validateRolePermissionImportRows(rows, catalog, options = {}) {
  const { partialImport = false } = options;
  const blockingErrors = [];
  const skippedRows = [];
  const warnings = [];
  let selectedCount = 0;
  let applicableCount = 0;

  if (!rows?.length) {
    blockingErrors.push("CSV has no data rows.");
    return buildImportValidationResult({
      blockingErrors,
      skippedRows,
      warnings,
      selectedCount,
      applicableCount,
      partialImport
    });
  }

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const line = i + 2;
    const selectedRaw = String(row.selected ?? row.granted ?? "").trim();
    const selected = selectedRaw.toLowerCase();
    const conditions = (row.conditions || "").trim();

    if (selectedRaw && selected !== "yes" && selected !== "no") {
      blockingErrors.push(`Row ${line}: Selected must be Yes or No (got "${selectedRaw}").`);
      continue;
    }

    if (selected !== "yes") {
      if (conditions) {
        warnings.push(`Row ${line}: Conditions is ignored when Selected is not Yes.`);
      }
      continue;
    }

    selectedCount++;

    if (conditions) {
      try {
        parseConditionsJson(conditions, `Row ${line}`);
      } catch (err) {
        blockingErrors.push(err.message);
        continue;
      }
    }

    const resolved = tryResolveImportRow(row, catalog);
    if (!resolved.ok) {
      skippedRows.push({
        line,
        message: resolved.error,
        label: formatImportRowLabel(row)
      });
      continue;
    }

    applicableCount++;
  }

  if (selectedCount === 0) {
    blockingErrors.push("No rows are marked Selected = Yes.");
  } else if (applicableCount === 0 && skippedRows.length > 0) {
    blockingErrors.push("No selected permissions exist in this org's catalog.");
  }

  return buildImportValidationResult({
    blockingErrors,
    skippedRows,
    warnings,
    selectedCount,
    applicableCount,
    partialImport
  });
}

function formatImportRowLabel(row) {
  if ((row.domain || "").trim().toLowerCase() === "general") {
    return `General > ${(row.action || "").trim()}`;
  }
  return [(row.domain || "").trim(), (row.entityName || "").trim(), (row.action || "").trim()]
    .filter(Boolean)
    .join(" > ");
}

function buildImportValidationResult({
  blockingErrors,
  skippedRows,
  warnings,
  selectedCount,
  applicableCount,
  partialImport
}) {
  const skippedCount = skippedRows.length;
  const canPartialImport =
    blockingErrors.length === 0 && skippedCount > 0 && applicableCount > 0;
  const valid = blockingErrors.length === 0 && (skippedCount === 0 || partialImport);
  const skippedMessages = skippedRows.map((entry) => `Row ${entry.line}: ${entry.message}`);

  return {
    valid,
    canPartialImport,
    partialImport: !!partialImport,
    blockingErrors,
    skippedRows,
    skippedCount,
    applicableCount,
    errors: [...blockingErrors, ...(partialImport ? [] : skippedMessages)],
    warnings,
    selectedCount
  };
}

function selectedRowsToRolePermissions(rows, catalog, options = {}) {
  const { skipUnresolved = false } = options;
  const validation = validateRolePermissionImportRows(rows, catalog, {
    partialImport: skipUnresolved
  });

  if (!validation.valid) {
    throw new Error(validation.blockingErrors[0] || validation.errors[0]);
  }

  const permissions = [];
  const policyMap = new Map();

  for (const row of rows) {
    if (!isSelectedYes(row)) continue;

    const resolved = tryResolveImportRow(row, catalog);
    if (!resolved.ok) {
      if (skipUnresolved) continue;
      throw new Error(resolved.error);
    }

    if (resolved.kind === "general") {
      permissions.push(resolveLegacyPermission(row.action));
      continue;
    }

    const { entity, action } = resolved;
    const conditions = (row.conditions || "").trim();
    const allowConditions = rowHasConditions(row);
    const policyKey = [entity.domain, entity.entityName, allowConditions ? "1" : "0", conditions].join("\0");

    if (!policyMap.has(policyKey)) {
      policyMap.set(policyKey, {
        domain: entity.domain,
        entityName: entity.entityName,
        actionSet: [action],
        allowConditions,
        conditions
      });
      continue;
    }

    const existing = policyMap.get(policyKey);
    if (!existing.actionSet.includes(action)) {
      existing.actionSet.push(action);
    }
  }

  const permissionPolicies = [];
  for (const policy of policyMap.values()) {
    const payload = {
      domain: policy.domain,
      entityName: policy.entityName,
      actionSet: policy.actionSet,
      allowConditions: policy.allowConditions
    };

    if (policy.allowConditions) {
      payload.resourceConditionNode = parseConditionsJson(
        policy.conditions,
        `${policy.domain}/${policy.entityName}`
      );
    }

    permissionPolicies.push(payload);
  }

  return {
    permissions: [...new Set(permissions)],
    permissionPolicies,
    skippedCount: validation.skippedCount
  };
}

function countSelectedPermissionRows(rows) {
  return rows.filter((row) => isSelectedYes(row)).length;
}

function countConditionalSelectedRows(rows) {
  return rows.filter((row) => isSelectedYes(row) && rowHasConditions(row)).length;
}

// Authorization / roles API helpers.

async function getAllRoles(fetch) {
  return fetchAllPages(fetch, "/api/v2/authorization/roles", { sortOrder: "ascending" });
}

async function getRole(fetch, roleId) {
  return fetch(`/api/v2/authorization/roles/${encodeURIComponent(roleId)}`);
}

async function updateRole(fetch, roleId, body) {
  return fetch(`/api/v2/authorization/roles/${encodeURIComponent(roleId)}`, {
    method: "PUT",
    body: JSON.stringify(body)
  });
}

function prepareRoleUpdateBody(role, permissionPayload) {
  const body = {
    name: role.name,
    description: role.description,
    permissions: permissionPayload.permissions,
    permissionPolicies: permissionPayload.permissionPolicies,
    default: role.default,
    base: role.base,
    roleNeedsUpdate: true
  };

  if (role.defaultRoleId) body.defaultRoleId = role.defaultRoleId;
  return body;
}
