const rolesPopupFeature = {
  id: "roleExport",
  panelId: "rolesExportPanel",
  awayNoteId: "rolesRunningAwayNote",

  getDescription(route) {
    return route?.description || "";
  },

  showPanel(show) {
    document.getElementById(this.panelId).hidden = !show;
  },

  showAwayNote(show) {
    document.getElementById(this.awayNoteId).classList.toggle("visible", show);
  },

  resultColumns() {
    return rolesImportShared.resultColumns();
  },

  init() {
    this.roles = [];
    this.pollTimer = null;
    this.uiReady = false;
    this.pendingDownload = false;

    document.getElementById("roleSelect").addEventListener("change", () => this.saveFormState());
    document.getElementById("rolesExport").addEventListener("click", () => {
      this.runExport().catch((err) => this.setError(err.message));
    });
    document.getElementById("rolesImport").addEventListener("click", () => {
      if (isFirefoxBrowser()) {
        this.startFirefoxImport().catch((err) => this.setError(err.message));
        return;
      }
      document.getElementById("rolesImportFile").click();
    });
    document.getElementById("rolesImportFile").addEventListener("change", (event) => {
      this.importCsv(event.target.files?.[0])
        .catch((err) => this.setError(err.message))
        .finally(() => {
          event.target.value = "";
        });
    });
    document.getElementById("rolesClear").addEventListener("click", () => {
      this.clearAll().catch((err) => this.setError(err.message));
    });
  },

  prefetchPermissionCatalog() {
    sendMsg({ type: "PREFETCH_PERMISSION_CATALOG" }).catch(() => {});
  },

  async consumeImportResult() {
    const { rolesImportResult } = await chrome.storage.session.get("rolesImportResult");
    if (!rolesImportResult?.message) return;
    await chrome.storage.session.remove("rolesImportResult");
    this.setJobStatus(rolesImportResult.message);
  },

  async setActive(isActive) {
    this.showPanel(isActive);
    if (isActive) {
      this.prefetchPermissionCatalog();
      this.showAwayNote(false);
      await this.ensureUiReady();
      await this.consumeImportResult();
      const state = await this.refreshExportState();
      if (state.status === "running") this.startPolling();
      else if (state.status === "idle") this.clearStatus();
      return;
    }

    const state = await sendMsg({ type: "GET_ROLES_EXPORT_STATE" });
    this.showAwayNote(state.status === "running");
    if (state.status === "running") this.startPolling();
    else this.stopPolling();
  },

  clearStatus() {
    const el = document.getElementById("rolesStatus");
    el.replaceChildren();
    el.style.color = "";
  },

  setError(msg) {
    const el = document.getElementById("rolesStatus");
    el.textContent = msg;
    el.style.color = "#a00";
  },

  setJobStatus(msg) {
    const el = document.getElementById("rolesStatus");
    el.style.color = "#555";
    el.replaceChildren();
    const label = document.createElement("strong");
    label.textContent = "Status:";
    el.append(label, " ", msg);
  },

  async saveFormState() {
    await chrome.storage.session.set({
      rolesPopupFormState: {
        roleId: document.getElementById("roleSelect").value
      }
    });
  },

  async restoreFormState() {
    const { rolesPopupFormState } = await chrome.storage.session.get("rolesPopupFormState");
    if (rolesPopupFormState?.roleId) {
      document.getElementById("roleSelect").value = rolesPopupFormState.roleId;
    }
  },

  async ensureUiReady() {
    if (this.uiReady) return;
    await this.loadRoles();
    await this.restoreFormState();
    this.uiReady = true;
  },

  async loadRoles() {
    const response = await sendMsg({ type: "GET_ROLES_LIST" });
    this.roles = response.roles || [];
    fillSelect(document.getElementById("roleSelect"), this.roles, "Select a role...", "id");
    console.log(`stagehand: loaded ${this.roles.length} roles`);
  },

  selectedRole() {
    const roleId = document.getElementById("roleSelect").value;
    if (!roleId) return null;
    const role = this.roles.find((entry) => entry.id === roleId);
    return {
      roleId,
      roleName: role?.name || roleId,
      isDefault: !!role?.default,
      isBase: !!role?.base
    };
  },

  setBusy(running) {
    document.getElementById("rolesExport").disabled = running;
    document.getElementById("rolesImport").disabled = running;
    document.getElementById("rolesNote").classList.toggle("visible", running);
  },

  async clearAll() {
    const state = await sendMsg({ type: "GET_ROLES_EXPORT_STATE" });
    if (state.status === "running") {
      this.setError("Operation still running — cannot clear until it finishes.");
      return;
    }

    this.stopPolling();
    this.pendingDownload = false;
    document.getElementById("roleSelect").value = "";
    await chrome.storage.session.remove("rolesPopupFormState");
    await chrome.storage.session.remove("rolesImportPending");
    await chrome.storage.session.set({ rolesExportState: { status: "idle" } });
    this.setBusy(false);
    this.clearStatus();
  },

  applyExportState(state) {
    if (!state || state.status === "idle") return;
    if (getPageContext()?.feature !== this.id) return;

    if (state.status === "running") {
      this.setBusy(true);
      this.setJobStatus(state.message);
      return;
    }

    this.setBusy(false);

    if (state.status === "done") {
      this.setJobStatus(state.message);
      if (state.roleId) {
        document.getElementById("roleSelect").value = state.roleId;
      }
      if (this.pendingDownload && state.results?.length) {
        this.pendingDownload = false;
        const roleName = state.roleName || this.selectedRole()?.roleName || "role";
        const safeName = roleName.replace(/[^\w.-]+/g, "_").slice(0, 40);
        downloadCsv(`stagehand_role_permissions_${safeName}.csv`, this.resultColumns(), state.results).catch(
          (err) => this.setError(err.message)
        );
      }
    }

    if (state.status === "error") {
      this.pendingDownload = false;
      this.setError(state.message);
    }
  },

  async refreshExportState() {
    const state = await sendMsg({ type: "GET_ROLES_EXPORT_STATE" });
    this.applyExportState(state);
    if (state.status !== "running") this.stopPolling();
    return state;
  },

  startPolling() {
    this.stopPolling();
    this.pollTimer = setInterval(() => {
      this.refreshExportState().catch((err) => this.setError(err.message));
    }, 500);
  },

  stopPolling() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  },

  async startFirefoxImport() {
    if (getPageContext()?.feature !== this.id) {
      this.setError("Open Roles and Permissions to import permissions.");
      return;
    }

    const selected = this.selectedRole();
    if (!selected) throw new Error("Select a role.");

    await chrome.storage.session.set({ rolesImportPending: selected });
    await chrome.tabs.create({ url: chrome.runtime.getURL("roles-import.html") });
    window.close();
  },

  async runExport() {
    if (getPageContext()?.feature !== this.id) {
      this.setError("Open Roles and Permissions to export permissions.");
      return;
    }

    const selected = this.selectedRole();
    if (!selected) throw new Error("Select a role.");

    this.pendingDownload = true;
    this.setJobStatus("Preparing export...");
    this.setBusy(true);

    await this.saveFormState();
    await sendMsg({
      type: "RUN_ROLES_EXPORT",
      payload: { roleId: selected.roleId, roleName: selected.roleName }
    });
    this.startPolling();
    await this.refreshExportState();
  },

  async importCsv(file) {
    if (!file) return;
    const text = await file.text();
    await this.importCsvFromText(text);
  },

  async importCsvFromText(text, selectedOverride) {
    if (getPageContext()?.feature !== this.id) {
      this.setError("Open Roles and Permissions to import permissions.");
      return;
    }

    const selected = selectedOverride || this.selectedRole();
    if (!selected) throw new Error("Select a role.");

    this.setJobStatus("Validating CSV...");
    const result = await rolesImportShared.importPermissionsFromText(text, selected);
    if (result.cancelled) {
      this.clearStatus();
      return;
    }

    this.pendingDownload = false;
    this.setJobStatus("Starting import...");
    this.setBusy(true);

    await this.saveFormState();
    this.startPolling();
    await this.refreshExportState();
  }
};
