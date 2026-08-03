(function () {
  const statusEl = document.getElementById("status");
  const roleSummaryEl = document.getElementById("roleSummary");
  const chooseBtn = document.getElementById("chooseCsv");
  const closeBtn = document.getElementById("closePage");
  const fileInput = document.getElementById("csvFile");

  let selectedRole = null;
  let pollTimer = null;

  function setStatus(msg, isError = false) {
    statusEl.textContent = msg;
    statusEl.classList.toggle("error", isError);
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  async function waitForImportResult() {
    return new Promise((resolve, reject) => {
      stopPolling();
      pollTimer = setInterval(async () => {
        try {
          const state = await sendMsg({ type: "GET_ROLES_EXPORT_STATE" });
          if (state.status === "running") {
            setStatus(state.message || "Import running…");
            return;
          }
          stopPolling();
          if (state.status === "done") {
            resolve(state);
            return;
          }
          if (state.status === "error") {
            reject(new Error(state.message || "Import failed."));
            return;
          }
        } catch (err) {
          stopPolling();
          reject(err);
        }
      }, 500);
    });
  }

  async function init() {
    const { rolesImportPending } = await chrome.storage.session.get("rolesImportPending");
    await chrome.storage.session.remove("rolesImportPending");

    if (!rolesImportPending?.roleId) {
      roleSummaryEl.textContent = "No role selected.";
      setStatus("Return to Roles and Permissions, select a role, and click Import again.", true);
      chooseBtn.disabled = true;
      return;
    }

    selectedRole = {
      roleId: rolesImportPending.roleId,
      roleName: rolesImportPending.roleName,
      isDefault: !!rolesImportPending.isDefault,
      isBase: !!rolesImportPending.isBase
    };
    roleSummaryEl.textContent = `Role: ${selectedRole.roleName}`;
  }

  chooseBtn.addEventListener("click", () => {
    fileInput.click();
  });

  closeBtn.addEventListener("click", () => {
    window.close();
  });

  fileInput.addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || !selectedRole) return;

    chooseBtn.disabled = true;
    setStatus("Reading CSV…");

    try {
      const text = await file.text();
      setStatus("Validating CSV…");
      const result = await rolesImportShared.importPermissionsFromText(text, selectedRole);
      if (result.cancelled) {
        setStatus("Import cancelled.");
        chooseBtn.disabled = false;
        return;
      }

      setStatus("Import running…");
      const state = await waitForImportResult();
      await sendMsg({ type: "ROLES_IMPORT_COMPLETE", message: state.message });
    } catch (err) {
      setStatus(err.message, true);
      chooseBtn.disabled = false;
    }
  });

  init().catch((err) => {
    setStatus(err.message, true);
    chooseBtn.disabled = true;
  });
})();
