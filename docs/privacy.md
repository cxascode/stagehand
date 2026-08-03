# stagehand — Privacy Policy

**Last updated:** July 2026

## Summary

stagehand runs entirely in your browser. It does not collect, sell, or
transmit your personal data to the extension developer or any third
party. All processing happens locally on your device.

## What stagehand does

stagehand is an unofficial admin browser extension that adds extra tools
to the Genesys Cloud web application — for example, querying historical
audit logs and exporting results to CSV.

When you use stagehand while logged into Genesys Cloud:

1. The extension reads the access token already present in your browser
   session from the Genesys Cloud admin tab you have open.
2. It uses that token to call Genesys Cloud Platform APIs (`api.*`) on
   your behalf — the same APIs the admin UI uses.
3. Results are shown in the extension popup or downloaded as a file you
   choose to save.

## What data stagehand accesses

| Data | How it is used | Where it goes |
|---|---|---|
| Genesys Cloud session token | Authenticate API requests | Browser session storage only; cleared when the browser closes |
| Active tab URL and page title | Match tools to the Genesys admin page you are viewing | Stays in the browser; not sent to third parties |
| Query parameters and API results | Run audit queries and display/export results | Stays in the browser until you close the browser or clear the extension session |

stagehand does **not**:

- Ask you to enter credentials
- Send data to servers operated by the extension developer
- Use analytics, tracking, or advertising SDKs
- Sell or share data with third parties

## Permissions

stagehand requests access to Genesys Cloud domains because:

- **`apps.*`** — the extension runs a content script on the Genesys Cloud
  admin UI to read your existing session token and detect which admin
  page you are viewing.
- **`api.*`** — the extension calls Genesys Cloud Platform APIs from
  your browser to run queries and retrieve results. Host permissions
  cover all Genesys Cloud regions because the extension derives the
  correct regional API base from whichever `apps.*` tab you are logged
  into.

Other permissions:

- **storage** — cache tokens and in-progress query state in browser
  session storage so the popup can restore state when reopened
- **tabs** / **activeTab** — determine which Genesys Cloud tab is active
- **downloads** — save CSV exports you request

## Data retention

- Session tokens and query state are kept in `chrome.storage.session`
  (or the Firefox equivalent) and are cleared when the browser session
  ends.
- CSV files are saved only when you click Export and choose a location
  on your device.

## Third parties

stagehand communicates only with **Genesys Cloud** (`apps.*` and
`api.*` domains) using your existing login session. No other third-party
services receive your data.

## Official status

stagehand is **not** created, reviewed, approved, or endorsed by
Genesys. For authoritative information about Genesys Cloud, see the
[Genesys Cloud Resource Center](https://help.genesys.cloud).

## Changes

If this policy changes, the updated version will be published at
[https://cxascode.github.io/stagehand/privacy.html](https://cxascode.github.io/stagehand/privacy.html)
with a revised date above.

## Contact

For questions about this extension or this policy, open an issue in the
[stagehand GitHub repository](https://github.com/cxascode/stagehand) or
visit [https://cxascode.github.io/stagehand/](https://cxascode.github.io/stagehand/).
