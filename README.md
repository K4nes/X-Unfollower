# X Unfollow

> Find and unfollow inactive accounts on X (Twitter) — no paid API key required.

**Created by [@firsdeka](https://x.com/firsdeka)**

---

## What It Does

X Unfollow is a Chrome/Edge browser extension that scans everyone you follow on X and identifies accounts that have been inactive past a threshold you choose (e.g. 30 days, 90 days, 1 year). You can then review the list and unfollow all of them in one click, safely and automatically.

It works entirely inside your browser using X's own internal web APIs — the same requests the x.com website makes. No official API key, no paid subscription, no third-party server.

---

## Installation

> The extension is loaded manually as an unpacked extension. Not yet listed in the Chrome Web Store.

1. Download or clone this repository to your computer.
2. Open Chrome (or Edge) and navigate to `chrome://extensions`.
3. Enable **Developer mode** using the toggle in the top-right corner.
4. Click **Load unpacked**.
5. Select the `X-Unfollower` folder.
6. The **X Unfollow** icon will appear in your browser toolbar.

To pin it for easy access: click the puzzle-piece extensions icon → find **X Unfollow** → click the pin icon.

---

## How to Use

1. Open [x.com](https://x.com) in the same browser window and make sure you are **logged in**. Scroll your timeline for a moment so the page makes its first API calls — this helps the extension capture your auth tokens automatically.
2. Click the **X Unfollow** icon in your toolbar to open the side panel.
3. Wait for the status bar at the top to show **Logged in** (green dot). If it shows "Not logged in", click the refresh button in the header (and try to refresh the tab).
4. Choose your **inactivity threshold** from the dropdown — accounts whose last original post is older than this will be flagged.
   - Options: 30 days, 90 days, 180 days, 1 year, or a custom number of days.
5. Click **Load Following**. The extension will:
   - Fetch every account you follow (paginated, up to 200 per request).
   - Check each account's last tweet date using their timeline.
   - Categorize each account as **No tweets**, **Inactive**, **Active**, or **Unknown**.
6. Use the **filter tabs** to switch between categories. Inactive and no-tweet accounts are pre-selected automatically.
7. Use **Select All / Deselect All** or click individual accounts to adjust your selection.
8. Use the **Sort** dropdown to reorder by inactivity, oldest/newest activity, or follower count.
9. Click **Unfollow Selected** to begin. A progress bar shows each unfollow as it happens. You can click **Stop** at any time to pause.

---

## How It Works

The extension has four components that work together:

### `content.js` — The API Engine (MAIN world)
Runs directly inside the x.com page context, giving it access to browser cookies (needed for authentication). It handles all communication with X's internal REST APIs:

- **Auth token acquisition** — Uses three strategies in order of preference:
  1. Searches already-loaded inline `<script>` blocks for the bearer token.
  2. Fetches X's external JS bundles and scans them for the token.
  3. Intercepts x.com's own `fetch` calls in real time to capture auth headers as they fly by.
  4. Falls back to a hardcoded public bearer token (X's own, embedded in their bundle since 2019).

- **Following list** — Calls `GET /1.1/friends/list.json` in pages of 200. Each page already contains the user's most recent status, so if their last action was an original post, no further request is needed for that account.

- **Activity enrichment** — For accounts whose last action was a retweet (or whose status was unavailable), calls `GET /1.1/statuses/user_timeline.json` to find the last original post. Retries up to 3 times on empty responses, and falls back to the retweet date if no original posts exist.

- **Unfollow** — Calls `POST /1.1/friendships/destroy.json` for each selected account, one at a time, with a 2-second gap between requests to stay well within rate limits.

- **Rate limit handling** — On a `429` response, reads the `x-rate-limit-reset` header to know exactly how long to wait, then resumes automatically.

### `bridge.js` — The Message Bridge (ISOLATED world)
A thin relay that sits between `content.js` (MAIN world) and `background.js` (service worker). Because Chrome's Manifest V3 prevents direct communication between the MAIN world and the extension, `bridge.js` forwards `window.postMessage` events to `chrome.runtime` and vice versa.

### `background.js` — The Service Worker
Manages the side panel, stores fetched account data in `chrome.storage.local` so the list persists across panel opens, and relays messages between the popup UI and the content script via the bridge.

### `popup/` — The UI (Side Panel)
A React-free vanilla JS/CSS interface rendered as a Chrome side panel. It shows login status, the controls bar, a live progress indicator, the filterable and sortable account list, and the unfollow footer.

---

## Architecture Overview

```
┌─────────────────────────────────────────────┐
│  Side Panel (popup.js / popup.html)         │
│  - Login status, controls, account list UI  │
└───────────────┬─────────────────────────────┘
                │ chrome.runtime messages
┌───────────────▼─────────────────────────────┐
│  background.js (Service Worker)             │
│  - Storage, tab management, message relay   │
└───────────────┬─────────────────────────────┘
                │ chrome.runtime messages
┌───────────────▼─────────────────────────────┐
│  bridge.js (ISOLATED world, x.com tab)      │
│  - Translates runtime ↔ window.postMessage  │
└───────────────┬─────────────────────────────┘
                │ window.postMessage
┌───────────────▼─────────────────────────────┐
│  content.js (MAIN world, x.com tab)         │
│  - Auth, X API calls, unfollow logic        │
└─────────────────────────────────────────────┘
```

---

## Rate Limits

X's internal APIs have rate limits. The extension handles them automatically — it will pause and display a countdown, then resume on its own.

| Operation | Approximate limit |
|---|---|
| Following list | ~15 pages (3 000 accounts) per 15 min |
| Activity check | 1 request per account · 150 ms gap |
| Unfollow | 1 per 2 seconds · ~400/day before X may flag |

If you follow a very large number of accounts, the full scan may take several minutes. You can cancel at any point and the results fetched so far will be saved locally.

---

## Privacy & Security

- The extension **never sends your data anywhere**. All API calls go directly from your browser to `x.com`.
- Auth tokens (bearer token, CSRF token, user ID) are read from your browser's cookies and used only to make requests on your behalf — exactly as x.com itself does.
- All fetched account data is stored in `chrome.storage.local` (your local browser storage only).
- Sensitive values are automatically redacted from any debug logs.

---

## Notes

- The extension only works while an **x.com tab is open** in the same Chrome window. The content script needs an active page to run API calls through.
- **Protected accounts** cannot have their timeline read — they will appear as "Unknown" and will not be pre-selected.
- Accounts with **zero tweets** are always marked as inactive (no activity is possible).
- The extension targets `x.com` and `twitter.com` (both work).

---

## Compatibility

| Browser | Supported |
|---|---|
| Google Chrome | ✓ |
| Microsoft Edge | ✓ |
| Firefox | ✗ (Manifest V3 side panel not supported) |
| Safari | ✗ |

---

*Built with vanilla JS, no external dependencies. Manifest V3.*
