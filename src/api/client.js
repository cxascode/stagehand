// Shared Genesys Platform API fetch wrapper for the background worker.
// Handles auth headers, 401, and 429 with Retry-After / Genesys error hints.

const RATE_LIMIT_MAX_RETRIES = 5;
const DEFAULT_RETRY_MS = 5000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfterMs(response, bodyText) {
  const header = response.headers.get("Retry-After");
  if (header) {
    const seconds = Number(header);
    if (!Number.isNaN(seconds)) return Math.max(0, seconds * 1000);
  }

  if (!bodyText) return DEFAULT_RETRY_MS;

  try {
    const parsed = JSON.parse(bodyText);
    const message = parsed.message || "";
    const bracketMatch = message.match(/\[(\d+)\]/);
    if (bracketMatch) return Number(bracketMatch[1]) * 1000;
  } catch {
    // body wasn't JSON — use default
  }

  return DEFAULT_RETRY_MS;
}

async function platformFetch(apiBase, token, path, options = {}, hooks = {}) {
  const url = `${apiBase}${path}`;
  const headers = {
    ...(options.headers || {}),
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json"
  };

  for (let attempt = 0; attempt <= RATE_LIMIT_MAX_RETRIES; attempt++) {
    const res = await fetch(url, { ...options, headers });

    if (res.status === 429 && attempt < RATE_LIMIT_MAX_RETRIES) {
      const bodyText = await res.text();
      const waitMs = parseRetryAfterMs(res, bodyText);
      if (hooks.onRateLimit) {
        hooks.onRateLimit({ waitMs, attempt: attempt + 1, maxAttempts: RATE_LIMIT_MAX_RETRIES });
      }
      await sleep(waitMs);
      continue;
    }

    if (res.status === 401) {
      if (hooks.onUnauthorized) hooks.onUnauthorized(apiBase);
      throw new Error("Token expired or invalid. Reload the Genesys Cloud tab and try again.");
    }

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`API error ${res.status}: ${text}`);
    }

    return res.json();
  }

  throw new Error("Rate limit exceeded — try again later.");
}
