// Role permissions export/import — background handlers.

const ROLES_STATE_KEY = "rolesExportState";
const ROLES_CACHE_KEY = "rolesList";

const ROLE_PERMISSION_COLUMNS = [
  { key: "selected", label: "Selected" },
  { key: "domain", label: "Domain" },
  { key: "entityName", label: "Entity Name" },
  { key: "action", label: "Action" },
  { key: "conditions", label: "Conditions" }
];

async function getRolesExportState() {
  const stored = await chrome.storage.session.get(ROLES_STATE_KEY);
  return stored[ROLES_STATE_KEY] || { status: "idle" };
}

async function setRolesExportState(state) {
  await chrome.storage.session.set({ [ROLES_STATE_KEY]: state });
}

async function fetchRolesList() {
  const roles = await getAllRoles(authedFetch);
  const sorted = roles
    .map((role) => ({
      id: role.id,
      name: role.name || role.id,
      default: !!role.default,
      base: !!role.base
    }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));

  await chrome.storage.session.set({ [ROLES_CACHE_KEY]: sorted });
  return sorted;
}

async function runRolesPermissionExport(payload) {
  const { roleId, roleName } = payload;
  if (!roleId) throw new Error("Select a role.");

  console.log("stagehand: role permissions export started", { roleId, roleName });

  await setRolesExportState({
    status: "running",
    feature: "roleExport",
    roleId,
    roleName,
    message: "Loading permission catalog...",
    results: [],
    roleSnapshot: null
  });

  const catalog = await loadPermissionCatalog(authedFetch);

  await setRolesExportState({
    status: "running",
    feature: "roleExport",
    roleId,
    roleName,
    message: "Fetching role permissions...",
    results: [],
    roleSnapshot: null
  });

  const role = await getRole(authedFetch, roleId);
  const results = buildFullPermissionMatrix(role, catalog);
  const selectedCount = countSelectedPermissionRows(results);
  const conditionalCount = countConditionalSelectedRows(results);
  let message = `Done. ${selectedCount} of ${results.length} permissions selected.`;
  if (conditionalCount) {
    message += ` ${conditionalCount} include conditions (kept in CSV — edit Selected only).`;
  }

  await setRolesExportState({
    status: "done",
    feature: "roleExport",
    roleId,
    roleName,
    message,
    results,
    roleSnapshot: role
  });

  console.log("stagehand: role permissions export complete", {
    roleId,
    roleName,
    resultCount: results.length
  });

  return results;
}

async function runRolesPermissionImport(payload) {
  const { roleId, roleName, rows } = payload;
  if (!roleId) throw new Error("Select a role.");
  if (!rows?.length) throw new Error("CSV has no permission rows.");

  console.log("stagehand: role permissions import started", {
    roleId,
    roleName,
    rowCount: rows.length
  });

  await setRolesExportState({
    status: "running",
    feature: "roleExport",
    roleId,
    roleName,
    message: "Loading permission catalog...",
    results: rows,
    roleSnapshot: null
  });

  const catalog = await loadPermissionCatalog(authedFetch);

  const partialImport = !!payload.partialImport;
  if (partialImport && !payload.partialImportAccepted) {
    throw new Error("Partial import requires confirmation in the popup.");
  }

  const validation = validateRolePermissionImportRows(rows, catalog, { partialImport });
  if (!validation.valid) {
    throw new Error(validation.blockingErrors[0] || validation.errors[0]);
  }

  await setRolesExportState({
    status: "running",
    feature: "roleExport",
    roleId,
    roleName,
    message: "Updating role permissions...",
    results: rows,
    roleSnapshot: null
  });

  const role = await getRole(authedFetch, roleId);
  if ((role.default || role.base) && !payload.riskAccepted) {
    throw new Error(
      "Import on default or base roles requires accepting the risk in the confirmation dialog."
    );
  }
  const permissionPayload = selectedRowsToRolePermissions(rows, catalog, {
    skipUnresolved: partialImport
  });
  const updateBody = prepareRoleUpdateBody(role, permissionPayload);
  const updatedRole = await updateRole(authedFetch, roleId, updateBody);
  const results = buildFullPermissionMatrix(updatedRole, catalog);
  const selectedCount = countSelectedPermissionRows(results);
  let message = `Imported. ${selectedCount} of ${results.length} permissions selected.`;
  if (partialImport && validation.skippedCount) {
    message += ` Skipped ${validation.skippedCount} not in this org.`;
  }

  await setRolesExportState({
    status: "done",
    feature: "roleExport",
    roleId,
    roleName: updatedRole.name || roleName,
    message,
    results,
    roleSnapshot: updatedRole
  });

  console.log("stagehand: role permissions import complete", {
    roleId,
    roleName: updatedRole.name || roleName,
    resultCount: results.length
  });

  return results;
}

function registerRolesBackgroundHandlers(register) {
  register("PREFETCH_PERMISSION_CATALOG", async (_msg, _sender, sendResponse) => {
    prefetchPermissionCatalog(authedFetch).catch((err) => {
      console.warn("stagehand: permission catalog prefetch failed", err.message);
    });
    sendResponse({ started: true });
  });

  register("GET_ROLES_LIST", async (_msg, _sender, sendResponse) => {
    sendResponse({ roles: await fetchRolesList() });
  });

  register("GET_ROLES_EXPORT_STATE", async (_msg, _sender, sendResponse) => {
    sendResponse(await getRolesExportState());
  });

  register("GET_ROLE_PERMISSION_COLUMNS", async (_msg, _sender, sendResponse) => {
    sendResponse({ columns: ROLE_PERMISSION_COLUMNS });
  });

  register("VALIDATE_ROLES_IMPORT", async (msg, _sender, sendResponse) => {
    const rows = msg.payload?.rows || [];
    const roleId = msg.payload?.roleId;
    const partialImport = !!msg.payload?.partialImport;
    const catalog = await loadPermissionCatalog(authedFetch);
    const validation = validateRolePermissionImportRows(rows, catalog, { partialImport });

    if (roleId && (validation.valid || validation.canPartialImport)) {
      try {
        const role = await getRole(authedFetch, roleId);
        const diffOptions =
          partialImport || validation.canPartialImport ? { skipUnresolved: true } : {};
        validation.diff = compareRolePermissionImport(role, rows, catalog, diffOptions);
      } catch (err) {
        validation.warnings = [
          ...(validation.warnings || []),
          `Could not compare to current role: ${err.message}`
        ];
      }
    }

    sendResponse(validation);
  });

  register("RUN_ROLES_EXPORT", async (msg, _sender, sendResponse) => {
    const page = await getActiveTabPageContext();
    if (page.feature !== "roleExport") {
      sendResponse({ error: page.message || "Open Roles and Permissions to export permissions." });
      return;
    }

    const state = await getRolesExportState();
    if (state.status === "running") {
      sendResponse({ error: "A role operation is already running in this browser session." });
      return;
    }

    runRolesPermissionExport(msg.payload).catch(async (err) => {
      const prev = await getRolesExportState();
      await setRolesExportState({
        ...prev,
        status: "error",
        message: err.message
      });
    });
    sendResponse({ started: true });
  });

  register("RUN_ROLES_IMPORT", async (msg, _sender, sendResponse) => {
    if (!msg.payload?.fromImportPage) {
      const page = await getActiveTabPageContext();
      if (page.feature !== "roleExport") {
        sendResponse({ error: page.message || "Open Roles and Permissions to import permissions." });
        return;
      }
    }

    const state = await getRolesExportState();
    if (state.status === "running") {
      sendResponse({ error: "A role operation is already running in this browser session." });
      return;
    }

    runRolesPermissionImport(msg.payload).catch(async (err) => {
      const prev = await getRolesExportState();
      await setRolesExportState({
        ...prev,
        status: "error",
        message: err.message
      });
    });
    sendResponse({ started: true });
  });
}
