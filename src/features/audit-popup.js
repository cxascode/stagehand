const auditPopupFeature = {
  id: "auditQuery",
  panelId: "auditQueryPanel",
  awayNoteId: "auditRunningAwayNote",

  getDescription(route) {
    return route?.description || "";
  },

  showPanel(show) {
    document.getElementById(this.panelId).hidden = !show;
  },

  showAwayNote(show) {
    document.getElementById(this.awayNoteId).classList.toggle("visible", show);
  },

  init() {
    this.lastResults = [];
    this.serviceMapping = { services: [] };
    this.pollTimer = null;
    this.uiReady = false;
    this.lastLoggedServiceCount = -1;
    this.lastLoggedQueryStateKey = "";
    this.configureDateInputs();

    document.getElementById("serviceName").addEventListener("change", () => {
      this.onServiceChange();
      this.saveFormState();
    });
    document.getElementById("entityType").addEventListener("change", () => {
      this.onEntityChange();
      this.saveFormState();
    });
    document.getElementById("action").addEventListener("change", () => this.saveFormState());
    for (const id of ["start", "end"]) {
      const el = document.getElementById(id);
      el.addEventListener("change", () => this.saveFormState());
      if (this.usesTextDatetime) {
        el.addEventListener("input", () => this.saveFormState());
        el.addEventListener("blur", () => this.normalizeDatetimeField(el));
      }
    }
    document.getElementById("run").addEventListener("click", () => {
      this.runQuery().catch((err) => this.setError(err.message));
    });
    document.getElementById("exportCsv").addEventListener("click", () => {
      this.downloadCsv().catch((err) => this.setError(err.message));
    });
    document.getElementById("clear").addEventListener("click", () => {
      this.clearAll().catch((err) => this.setError(err.message));
    });
  },

  async setActive(isActive, pageContext) {
    this.showPanel(isActive);
    if (isActive) {
      this.showAwayNote(false);
      await this.ensureUiReady();
      const state = await this.refreshQueryState();
      if (state.status === "running") this.startPolling();
      else this.clearStatus();
      return;
    }

    const state = await sendMsg({ type: "GET_AUDIT_QUERY_STATE" });
    this.showAwayNote(state.status === "running");
    if (state.status === "running") this.startPolling();
    else this.stopPolling();
  },

  clearStatus() {
    const el = document.getElementById("status");
    el.replaceChildren();
    el.style.color = "";
  },

  setError(msg) {
    const el = document.getElementById("status");
    el.textContent = msg;
    el.style.color = "#a00";
  },

  setJobStatus(msg) {
    const el = document.getElementById("status");
    el.style.color = "#555";
    el.replaceChildren();
    const label = document.createElement("strong");
    label.textContent = "Status:";
    el.append(label, " ", msg);
  },

  logServicesLoaded() {
    const count = this.serviceMapping.services.length;
    if (!count || count === this.lastLoggedServiceCount) return;
    this.lastLoggedServiceCount = count;
    console.log(`stagehand: loaded ${count} services`);
  },

  logQueryState(state) {
    if (!state || state.status === "idle") return;
    const key = [
      state.status,
      state.transactionId || "",
      state.serverState || "",
      state.chunkIndex ?? "",
      state.message || ""
    ].join("|");
    if (key === this.lastLoggedQueryStateKey) return;
    this.lastLoggedQueryStateKey = key;
    console.log("stagehand: query state", {
      status: state.status,
      transactionId: state.transactionId || null,
      serverState: state.serverState || null,
      chunkIndex: state.chunkIndex ?? null,
      chunkCount: state.chunkCount ?? null,
      message: state.message || null
    });
  },

  onServiceChange() {
    const serviceName = document.getElementById("serviceName").value;
    const entitySelect = document.getElementById("entityType");
    const actionSelect = document.getElementById("action");
    const service = this.serviceMapping.services.find((s) => s.name === serviceName);
    const entities = service ? service.entities.map((e) => e.name) : [];
    fillSelect(entitySelect, entities, "Any");
    entitySelect.disabled = !serviceName;
    fillSelect(actionSelect, [], "Any");
    actionSelect.disabled = true;
  },

  onEntityChange() {
    const serviceName = document.getElementById("serviceName").value;
    const entityName = document.getElementById("entityType").value;
    const actionSelect = document.getElementById("action");
    const service = this.serviceMapping.services.find((s) => s.name === serviceName);
    const entity = service?.entities.find((e) => e.name === entityName);
    const actions = entity ? entity.actions : [];
    fillSelect(actionSelect, actions, "Any");
    actionSelect.disabled = !entityName;
  },

  buildFilters() {
    const filters = [];
    const entityType = document.getElementById("entityType").value;
    const action = document.getElementById("action").value;
    if (entityType) filters.push({ property: "EntityType", value: entityType });
    if (action) filters.push({ property: "Action", value: action });
    return filters;
  },

  usesTextDatetime: false,

  isFirefoxBrowser() {
    return typeof browser !== "undefined" && typeof browser.runtime?.getBrowserInfo === "function";
  },

  configureDateInputs() {
    this.usesTextDatetime = this.isFirefoxBrowser();
    if (!this.usesTextDatetime) return;

    const example = this.formatDatetimeForLocale(new Date());
    for (const id of ["start", "end"]) {
      const el = document.getElementById(id);
      el.type = "text";
      el.placeholder = example;
      el.setAttribute("spellcheck", "false");
      el.setAttribute("autocomplete", "off");
      el.removeAttribute("step");
    }
  },

  formatDatetimeForLocale(valueOrDate) {
    const normalized = this.toDatetimeLocalValue(valueOrDate);
    if (!normalized) return "";
    const parsed = new Date(normalized);
    if (Number.isNaN(parsed.getTime())) return normalized;
    const datePart = parsed.toLocaleDateString(undefined, {
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    });
    const timePart = parsed.toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit"
    });
    return `${datePart}, ${timePart}`;
  },

  normalizeDatetimeField(el) {
    const raw = el.value.trim();
    if (!raw) return;
    try {
      el.value = this.formatDatetimeForLocale(this.parseDatetimeInput(raw));
      this.saveFormState();
    } catch {
      // Leave invalid input for the user to fix on Run Query.
    }
  },

  setDatetimeFieldValue(id, valueOrDate) {
    const normalized = this.toDatetimeLocalValue(valueOrDate);
    document.getElementById(id).value = this.usesTextDatetime
      ? this.formatDatetimeForLocale(normalized)
      : normalized;
  },

  toDatetimeLocalValue(valueOrDate) {
    if (valueOrDate instanceof Date) {
      const pad = (n) => String(n).padStart(2, "0");
      return `${valueOrDate.getFullYear()}-${pad(valueOrDate.getMonth() + 1)}-${pad(valueOrDate.getDate())}T${pad(valueOrDate.getHours())}:${pad(valueOrDate.getMinutes())}`;
    }
    if (!valueOrDate) return "";
    const value = String(valueOrDate).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return `${value}T00:00`;
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) return value.slice(0, 16);
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return this.toDatetimeLocalValue(parsed);
    return value.split(".")[0].slice(0, 16);
  },

  datetimeInputToIso(value, label) {
    const normalized = this.parseDatetimeInput(value, label);
    return new Date(normalized).toISOString();
  },

  parseDatetimeInput(value, label) {
    const raw = String(value || "").trim();
    if (!raw) {
      throw new Error(label ? `Pick a ${label.toLowerCase()} date/time.` : "Pick a start and end date/time.");
    }
    const parsed = new Date(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(raw) ? raw : raw);
    if (Number.isNaN(parsed.getTime())) {
      throw new Error(label ? `${label} is not a valid date/time.` : "Invalid date/time.");
    }
    const normalized = this.toDatetimeLocalValue(parsed);
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(raw) && normalized !== raw) {
      throw new Error(label ? `${label} is not a valid date/time.` : "Invalid date/time.");
    }
    return normalized;
  },

  defaultDateRange() {
    const end = new Date();
    end.setSeconds(0, 0);
    const start = new Date(end);
    start.setDate(start.getDate() - 30);
    return {
      start: this.toDatetimeLocalValue(start),
      end: this.toDatetimeLocalValue(end)
    };
  },

  applyDefaultDateRange() {
    const { start, end } = this.defaultDateRange();
    this.setDatetimeFieldValue("start", start);
    this.setDatetimeFieldValue("end", end);
  },

  async saveFormState() {
    await chrome.storage.session.set({
      auditPopupFormState: {
        serviceName: document.getElementById("serviceName").value,
        entityType: document.getElementById("entityType").value,
        action: document.getElementById("action").value,
        start: document.getElementById("start").value,
        end: document.getElementById("end").value
      }
    });
  },

  async restoreFormState() {
    const { auditPopupFormState } = await chrome.storage.session.get("auditPopupFormState");
    if (!auditPopupFormState) {
      this.applyDefaultDateRange();
      return;
    }

    document.getElementById("serviceName").value = auditPopupFormState.serviceName || "";
    this.onServiceChange();
    document.getElementById("entityType").value = auditPopupFormState.entityType || "";
    this.onEntityChange();
    document.getElementById("action").value = auditPopupFormState.action || "";
    this.setDatetimeFieldValue("start", auditPopupFormState.start);
    this.setDatetimeFieldValue("end", auditPopupFormState.end);
  },

  async ensureUiReady() {
    if (this.uiReady) return;
    await this.loadServiceMapping();
    await this.restoreFormState();
    this.uiReady = true;
  },

  setQueryRunning(running) {
    document.getElementById("run").disabled = running;
    document.getElementById("queryNote").classList.toggle("visible", running);
  },

  resetFormUI() {
    document.getElementById("serviceName").value = "";
    this.onServiceChange();
    this.applyDefaultDateRange();
  },

  clearResults() {
    this.lastResults = [];
    document.getElementById("resultsTable").replaceChildren();
    document.getElementById("exportCsv").hidden = true;
  },

  async clearAll() {
    const state = await sendMsg({ type: "GET_AUDIT_QUERY_STATE" });
    if (state.status === "running") {
      this.setError("Query still running on Genesys — cannot clear until it finishes.");
      return;
    }

    this.stopPolling();
    this.clearResults();
    this.resetFormUI();
    await chrome.storage.session.remove("auditPopupFormState");
    await chrome.storage.session.set({ auditQueryState: { status: "idle" } });
    this.setQueryRunning(false);
    this.lastLoggedQueryStateKey = "";
    this.logServicesLoaded();
    this.clearStatus();
  },

  applyQueryState(state) {
    if (!state || state.status === "idle") return;
    if (getPageContext()?.feature !== this.id) return;

    this.logQueryState(state);

    if (state.status === "running") {
      this.setQueryRunning(true);
      this.setJobStatus(state.message);
      return;
    }

    this.setQueryRunning(false);

    if (state.status === "done") {
      this.lastResults = state.results || [];
      this.renderTable(this.lastResults);
      this.setJobStatus(state.message);
    }

    if (state.status === "error") {
      if (state.results?.length) {
        this.lastResults = state.results;
        this.renderTable(this.lastResults);
      }
      this.setError(state.message);
    }
  },

  async refreshQueryState() {
    const state = await sendMsg({ type: "GET_AUDIT_QUERY_STATE" });
    this.applyQueryState(state);
    if (state.status !== "running") this.stopPolling();
    return state;
  },

  startPolling() {
    this.stopPolling();
    this.pollTimer = setInterval(() => {
      this.refreshQueryState().catch((err) => this.setError(err.message));
    }, 1000);
  },

  stopPolling() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  },

  async loadServiceMapping() {
    const cached = await chrome.storage.session.get("serviceMapping");
    if (cached.serviceMapping?.services) {
      this.serviceMapping = cached.serviceMapping;
    }

    try {
      const mapping = await sendMsg({ type: "GET_SERVICE_MAPPING" });
      this.serviceMapping = mapping.services ? mapping : { services: [] };
      fillSelect(
        document.getElementById("serviceName"),
        this.serviceMapping.services.map((s) => s.name),
        "Select a service..."
      );
      this.logServicesLoaded();
    } catch (err) {
      if (!this.serviceMapping.services.length) throw err;
    }
  },

  extractEntity(entity) {
    if (!entity) return "";
    if (typeof entity === "string") return entity;
    return entity.name || entity.id || "";
  },

  extractUser(user) {
    if (!user) return "";
    if (typeof user === "string") return user;
    return user.id || user.name || "";
  },

  formatEventDate(iso) {
    if (!iso) return "";
    return new Date(iso).toLocaleString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true
    });
  },

  normalizeAuditRow(row) {
    return {
      serviceName: row.serviceName || "",
      entity: this.extractEntity(row.entity),
      entityType: row.entityType || "",
      action: row.action || "",
      user: this.extractUser(row.user),
      dateTime: this.formatEventDate(row.eventDate)
    };
  },

  renderTable(rows) {
    this.lastResults = renderResultsTable(
      "resultsTable",
      "exportCsv",
      [
        { key: "serviceName", label: "Service Name" },
        { key: "entity", label: "Entity" },
        { key: "entityType", label: "Entity Type" },
        { key: "action", label: "Action" },
        { key: "user", label: "User" },
        { key: "dateTime", label: "Date and Time" }
      ],
      rows,
      (row) => this.normalizeAuditRow(row)
    );
  },

  downloadCsv() {
    downloadCsv(
      "stagehand_audit_results.csv",
      [
        { key: "serviceName", label: "Service Name" },
        { key: "entity", label: "Entity" },
        { key: "entityType", label: "Entity Type" },
        { key: "action", label: "Action" },
        { key: "user", label: "User" },
        { key: "dateTime", label: "Date and Time" }
      ],
      this.lastResults
    );
  },

  async runQuery() {
    if (getPageContext()?.feature !== this.id) {
      this.setError("Open Audit Viewer to run queries.");
      return;
    }

    this.setJobStatus("Starting query...");
    this.setQueryRunning(true);
    document.getElementById("exportCsv").hidden = true;
    this.clearResults();

    const serviceName = document.getElementById("serviceName").value;
    if (!serviceName) throw new Error("Select a service name.");

    const startInput = document.getElementById("start").value;
    const endInput = document.getElementById("end").value;

    const payload = {
      serviceName,
      filters: this.buildFilters(),
      start: this.datetimeInputToIso(startInput, "Start"),
      end: this.datetimeInputToIso(endInput, "End")
    };

    await this.saveFormState();
    await sendMsg({ type: "RUN_AUDIT_QUERY", payload });
    this.startPolling();
    await this.refreshQueryState();
  }
};
