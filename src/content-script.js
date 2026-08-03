(function () {
  // gcui_auth (sessionStorage) is the simplest, most reliable source:
  // just the raw bearer token as a plain string, no JSON wrapper. Check
  // this before anything else.
  const PLAIN_STRING_KEYS = ["gcui_auth"];

  // Fallback JSON-based keys, in priority order, if gcui_auth isn't present.
  const PRIORITY_KEYS = ["pc_auth", "web_dir_auth"];

  function deriveApiBase(hostname) {
    // apps.<rest-of-domain> -> api.<rest-of-domain>
    if (hostname.startsWith("apps.")) {
      return "https://api." + hostname.slice("apps.".length);
    }
    return null;
  }

  function looksLikeToken(value) {
    return typeof value === "string" && value.length > 20 && !/\s/.test(value);
  }

  function findPlainStringToken(storage) {
    for (const key of PLAIN_STRING_KEYS) {
      const raw = storage.getItem(key);
      if (looksLikeToken(raw)) {
        return { token: raw, expiry: null, sourceKey: key };
      }
    }
    return null;
  }

  // A token can live at the top level ({accessToken: "..."}) or nested
  // under "authenticated" / "secure" ({authenticated: {access_token: "..."}}).
  function extractFromShape(shape) {
    if (!shape || typeof shape !== "object") return null;
    const token = shape.accessToken || shape.access_token;
    if (!looksLikeToken(token)) return null;
    const expiry =
      shape.tokenExpiryTime ||
      shape.token_expiry_time_millis ||
      shape.expiry ||
      null;
    return { token, expiry: expiry ? Number(expiry) : null };
  }

  function findJsonCandidatesInStorage(storage) {
    const candidates = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      const raw = storage.getItem(key);
      if (!raw) continue;
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (e) {
        continue; // not JSON, skip
      }
      const shapes = [parsed, parsed.authenticated, parsed.secure];
      for (const shape of shapes) {
        const extracted = extractFromShape(shape);
        if (extracted) {
          candidates.push({ ...extracted, sourceKey: key });
          break; // one candidate per key is enough
        }
      }
    }
    return candidates;
  }

  function pickBestToken() {
    const plainMatch =
      findPlainStringToken(window.sessionStorage) || findPlainStringToken(window.localStorage);
    if (plainMatch) return plainMatch;

    const candidates = [
      ...findJsonCandidatesInStorage(window.localStorage),
      ...findJsonCandidatesInStorage(window.sessionStorage)
    ];

    const now = Date.now();
    const notExpired = (c) => c.expiry === null || c.expiry > now;
    const valid = candidates.filter(notExpired);

    if (valid.length === 0) return null;

    for (const priorityKey of PRIORITY_KEYS) {
      const match = valid.find((c) => c.sourceKey === priorityKey);
      if (match) return match;
    }

    return valid[0];
  }

  function safeSendMessage(message) {
    if (!chrome.runtime?.id) return;
    try {
      chrome.runtime.sendMessage(message, () => {
        void chrome.runtime.lastError;
      });
    } catch {
      // Extension was reloaded or is unavailable in this tab.
    }
  }

  const apiBase = deriveApiBase(window.location.hostname);
  const found = pickBestToken();

  if (found && apiBase) {
    safeSendMessage({ type: "TOKEN_FOUND", ...found, apiBase });
  } else {
    safeSendMessage({
      type: "TOKEN_NOT_FOUND",
      reason: !apiBase
        ? `Unexpected hostname pattern: ${window.location.hostname}`
        : "No unexpired token-like value found in storage."
    });
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === "GET_LOCATION") {
      sendResponse({
        href: window.location.href,
        hash: window.location.hash,
        title: document.title
      });
      return true;
    }

    if (msg.type === "SHOW_STAGEHAND_TOAST") {
      showStagehandToast(msg.message || "Done.");
      sendResponse({ ok: true });
      return true;
    }
  });

  function showStagehandToast(message) {
    const existing = document.getElementById("stagehand-toast");
    if (existing) existing.remove();

    const toast = document.createElement("div");
    toast.id = "stagehand-toast";
    toast.textContent = message;
    Object.assign(toast.style, {
      position: "fixed",
      top: "16px",
      right: "16px",
      zIndex: "2147483647",
      maxWidth: "360px",
      padding: "12px 14px",
      background: "#1f2937",
      color: "#fff",
      font: "13px/1.4 system-ui, sans-serif",
      borderRadius: "8px",
      boxShadow: "0 8px 24px rgba(0,0,0,0.2)"
    });
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 8000);
  }

  function notifyRouteChange() {
    safeSendMessage({
      type: "ROUTE_CHANGED",
      href: window.location.href,
      hash: window.location.hash,
      title: document.title
    });
  }

  window.addEventListener("hashchange", notifyRouteChange);
  window.addEventListener("popstate", notifyRouteChange);
})();
