const rolesImportShared = {
  resultColumns() {
    return [
      { key: "selected", label: "Selected" },
      { key: "domain", label: "Domain" },
      { key: "entityName", label: "Entity Name" },
      { key: "action", label: "Action" },
      { key: "conditions", label: "Conditions" }
    ];
  },

  formatImportConfirmMessage(roleName, selected, validation, previewLimit = 5) {
    const diff = validation.diff;
    const lines = [`Import into "${roleName}"?`, ""];

    if (diff) {
      lines.push(`+ ${diff.addedCount} added`);
      lines.push(`− ${diff.removedCount} removed`);
      lines.push(`${diff.unchangedCount} unchanged`);

      if (diff.addedCount) {
        lines.push("", "Added:");
        for (const label of diff.added.slice(0, previewLimit)) {
          lines.push(`  ${label}`);
        }
        if (diff.addedCount > previewLimit) {
          lines.push(`  (+${diff.addedCount - previewLimit} more)`);
        }
      }

      if (diff.removedCount) {
        lines.push("", "Removed:");
        for (const label of diff.removed.slice(0, previewLimit)) {
          lines.push(`  ${label}`);
        }
        if (diff.removedCount > previewLimit) {
          lines.push(`  (+${diff.removedCount - previewLimit} more)`);
        }
      }

      if (diff.addedCount === 0 && diff.removedCount === 0) {
        lines.push("", "No permission changes detected.");
      }
    } else {
      lines.push(`Apply ${validation.selectedCount} selected permission(s).`);
    }

    lines.push("", "Import replaces all permissions on the role.");

    if (validation.partialImport && validation.skippedCount) {
      lines.push("", `Skipping ${validation.skippedCount} permission(s) not in this org.`);
    }

    return lines.join("\n");
  },

  confirmPartialOverrideDialog(validation, previewLimit = 8) {
    const overlay = document.getElementById("rolesImportPartial");
    const messageEl = document.getElementById("rolesImportPartialMessage");
    const countEl = document.getElementById("rolesImportPartialCount");
    const checkbox = document.getElementById("rolesImportPartialAccept");
    const proceedBtn = document.getElementById("rolesImportPartialProceed");
    const cancelBtn = document.getElementById("rolesImportPartialCancel");

    const lines = [
      `${validation.skippedCount} selected permission(s) are not in this org's catalog.`,
      `${validation.applicableCount} can still be imported.`,
      ""
    ];

    for (const entry of validation.skippedRows.slice(0, previewLimit)) {
      lines.push(`Row ${entry.line}: ${entry.label || entry.message}`);
    }
    if (validation.skippedCount > previewLimit) {
      lines.push(`(+${validation.skippedCount - previewLimit} more)`);
    }

    messageEl.textContent = lines.join("\n");
    countEl.textContent = String(validation.skippedCount);
    checkbox.checked = false;
    proceedBtn.disabled = true;
    overlay.hidden = false;

    return new Promise((resolve) => {
      const cleanup = () => {
        overlay.hidden = true;
        proceedBtn.removeEventListener("click", onProceed);
        cancelBtn.removeEventListener("click", onCancel);
        checkbox.removeEventListener("change", onCheckboxChange);
      };

      const onProceed = () => {
        if (!checkbox.checked) return;
        cleanup();
        resolve(true);
      };

      const onCancel = () => {
        cleanup();
        resolve(false);
      };

      const onCheckboxChange = () => {
        proceedBtn.disabled = !checkbox.checked;
      };

      proceedBtn.addEventListener("click", onProceed);
      cancelBtn.addEventListener("click", onCancel);
      checkbox.addEventListener("change", onCheckboxChange);
    });
  },

  confirmImportDialog(selected, validation) {
    const requireRiskAcceptance = !!(selected.isDefault || selected.isBase);
    const overlay = document.getElementById("rolesImportConfirm");
    const messageEl = document.getElementById("rolesImportConfirmMessage");
    const riskBlock = document.getElementById("rolesImportRiskBlock");
    const roleTypeEl = document.getElementById("rolesImportRiskRoleType");
    const checkbox = document.getElementById("rolesImportRiskAccept");
    const proceedBtn = document.getElementById("rolesImportConfirmProceed");
    const cancelBtn = document.getElementById("rolesImportConfirmCancel");

    messageEl.textContent = this.formatImportConfirmMessage(selected.roleName, selected, validation);

    if (requireRiskAcceptance) {
      riskBlock.hidden = false;
      roleTypeEl.textContent = selected.isDefault ? "default" : "base";
      checkbox.checked = false;
      proceedBtn.disabled = true;
    } else {
      riskBlock.hidden = true;
      proceedBtn.disabled = false;
    }

    overlay.hidden = false;

    return new Promise((resolve) => {
      const cleanup = () => {
        overlay.hidden = true;
        proceedBtn.removeEventListener("click", onProceed);
        cancelBtn.removeEventListener("click", onCancel);
        checkbox.removeEventListener("change", onCheckboxChange);
      };

      const onProceed = () => {
        if (requireRiskAcceptance && !checkbox.checked) return;
        cleanup();
        resolve(true);
      };

      const onCancel = () => {
        cleanup();
        resolve(false);
      };

      const onCheckboxChange = () => {
        proceedBtn.disabled = requireRiskAcceptance && !checkbox.checked;
      };

      proceedBtn.addEventListener("click", onProceed);
      cancelBtn.addEventListener("click", onCancel);
      checkbox.addEventListener("change", onCheckboxChange);
    });
  },

  async importPermissionsFromText(text, selected) {
    const rows = parseCsv(text, this.resultColumns());
    if (!rows.length) throw new Error("CSV has no data rows.");

    let validation = await sendMsg({
      type: "VALIDATE_ROLES_IMPORT",
      payload: { rows, roleId: selected.roleId }
    });

    let partialImport = false;

    if (!validation.valid && validation.canPartialImport) {
      const accepted = await this.confirmPartialOverrideDialog(validation);
      if (!accepted) return { cancelled: true };
      partialImport = true;
      validation = await sendMsg({
        type: "VALIDATE_ROLES_IMPORT",
        payload: { rows, roleId: selected.roleId, partialImport: true }
      });
    }

    if (!validation.valid) {
      throw new Error((validation.blockingErrors || validation.errors).join("\n"));
    }

    if (validation.warnings?.length) {
      console.warn("stagehand: import warnings", validation.warnings);
    }

    const riskAccepted = await this.confirmImportDialog(selected, validation);
    if (riskAccepted !== true) return { cancelled: true };

    await sendMsg({
      type: "RUN_ROLES_IMPORT",
      payload: {
        roleId: selected.roleId,
        roleName: selected.roleName,
        rows,
        partialImport,
        partialImportAccepted: partialImport,
        riskAccepted: !!(selected.isDefault || selected.isBase),
        fromImportPage: isFirefoxBrowser()
      }
    });

    return { started: true };
  }
};
