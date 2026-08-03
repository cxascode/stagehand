# stagehand

A Chrome/Firefox extension that adds **contextual admin tools** to the
Genesys Cloud web UI. Open the popup on an admin page you already have
loaded — if stagehand has a tool for that page, it appears; otherwise you
see a short note that nothing is available there yet.

Tools use the access token your browser already has from being logged
into Genesys Cloud. No credentials are entered into the extension, no OAuth
client registration, and no config file to edit. The token is read at
runtime and kept in browser session storage (cleared when the browser
closes).

**Unofficial** — not created, reviewed, approved, or endorsed by Genesys.

Homepage: [https://cxascode.github.io/stagehand/](https://cxascode.github.io/stagehand/)

**Install:** [Chrome Web Store](https://chromewebstore.google.com/detail/cnnganbcklcigfiobbihdddabffplmlc) · [Firefox Add-ons](https://addons.mozilla.org/en-US/firefox/addon/stagehand/)

## How it works

1. You log into Genesys Cloud admin in a normal browser tab (`apps.*`).
2. stagehand matches the tab URL (hash route) against a route table in
   `src/routes.js`.
3. When a route matches, the popup shows that page's tool(s).
4. The extension calls Genesys Platform APIs (`api.*`) on your behalf
   using your existing session — all processing stays in the browser.

Page title and description in the popup come from the live admin tab.
Navigate away or switch tabs and the popup updates to match.

## Available tools

| Page | Route | What it does |
|---|---|---|
| **Audit Viewer** | `#/admin/troubleshooting/auditviewer` | Search historical audit logs (up to 1 year) and export results to CSV |

More admin pages can be added by extending `PAGE_ROUTES` and wiring a
feature module.

### Audit Viewer — historical audit query

Queries `/api/v2/audits/query` (full history). **Realtime** audits
(`/query/realtime`, last 14 days) are intentionally out of scope — the
product UI already covers those.

Genesys constraints handled automatically:

- **1-year retention** — start dates older than that are clamped; the
  popup tells you when it happens
- **30-day max per query** — longer ranges are split into consecutive
  chunks, run sequentially, and combined into one table/CSV

**Caution:** Genesys allows **one historical audit query per organization
at a time** (org-wide, not per user). There is no cancel API — if another
admin is running a query, wait for it to finish.

To use it:

1. Go to **Admin → Troubleshooting → Audit Viewer**
2. Open the stagehand popup
3. Pick **Service**, optional **Entity Type** / **Action**, and a date
   range (defaults to the last 30 days through today, midnight)
4. **Run Query**, then **Export CSV** when results are ready

## Repo layout

```
src/
  routes.js           URL hash → feature routing
  popup.html/js       Context-aware popup UI
  help.html/js        In-extension help (built from PAGE_ROUTES)
  content-script.js   Token extraction, live URL/hash
  background.js       Orchestration, query state
  api/                Per-API-family HTTP modules
manifests/
  manifest.chrome.json
  manifest.firefox.json
.github/workflows/build.yml
docs/                 GitHub Pages (homepage, privacy)
scripts/build.py
```

`src/` is browser-agnostic — only the manifest differs per target. CI
copies `src/` plus the right manifest into `build/<browser>/` and zips
it; nothing under `build/` is checked into git.

## CI

On every push/PR to `main`, GitHub Actions builds both targets and
uploads workflow artifacts (`stagehand-chrome-<version>`, `stagehand-firefox-<version>`).
Download from the Actions run summary. See `.github/workflows/build.yml`.

## Local build

```bash
python3 scripts/build.py           # both browsers
python3 scripts/build.py chrome    # one target
```

Outputs:

- `build/chrome/` or `build/firefox/` — load unpacked for testing
- `build/stagehand-chrome-<version>.zip` — upload to the Chrome Web Store

## Install

- **Chrome / Edge / Brave:** [Chrome Web Store](https://chromewebstore.google.com/detail/cnnganbcklcigfiobbihdddabffplmlc)
- **Firefox:** [Firefox Add-ons](https://addons.mozilla.org/en-US/firefox/addon/stagehand/)

### Install from source — Chrome

1. `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select `build/chrome`

### Install from source — Firefox

1. `about:debugging` → **This Firefox** → **Load Temporary Add-on**
2. Select `build/firefox/manifest.json`

Temporary add-ons are removed on browser restart. For a normal install, use
[Firefox Add-ons](https://addons.mozilla.org/en-US/firefox/addon/stagehand/).

## Multi-region / multi-tab behavior

Tokens are cached **per region**, not globally. Multiple tabs on the
same region share one cached token. Tabs on different regions each get
their own slot. When a tool runs, stagehand uses whichever Genesys Cloud
tab is **currently active** — switch tabs to switch org/region.

The content script derives `api.<region>` from the active `apps.<region>`
tab.

## If the token isn't found

The content script looks for the token in this order:

1. `sessionStorage["gcui_auth"]` — plain-string bearer token
2. Known JSON keys (`pc_auth`, `web_dir_auth`) with nested
   `access_token`, filtered to discard expired entries
3. A generic scan of `localStorage`/`sessionStorage` for
   `{ accessToken: "..." }`-shaped values

If nothing is found:

1. Make sure the Genesys Cloud tab is fully loaded and you're logged in
2. Reload the tab (token is read at content-script inject time)
3. Open devtools → Application → Local/Session Storage, check the
   actual key/shape, and update `src/content-script.js`

## Notes

- Token lives only in memory / session storage — never synced across devices
- A 401 means the token expired — reload the Genesys Cloud tab and retry
- Firefox loads `routes.js` → `api/client.js` → `api/audits.js` →
  `background.js` in order (`importScripts` is not available in Firefox
  background scripts). Chrome uses a single service worker with
  `importScripts`.

## For maintainers

Building from source, CI artifacts, and privacy policy:
[`docs/privacy.md`](docs/privacy.md).
