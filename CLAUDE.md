# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

X Unfollow is a Chrome/Edge extension (Manifest V3) that finds and bulk-unfollows inactive accounts on X without requiring an API key. It uses X's internal v1.1 REST APIs directly from the browser.

**Vanilla JS, no npm dependencies. Load unpacked at `chrome://extensions` → Developer mode → Load unpacked.**

## Architecture

```
Side panel (popup/) ──► background.js ──► bridge.js (ISOLATED world) ──► content.js (MAIN world, on x.com)
```

| File | Role |
|------|------|
| `content.js` | Runs in MAIN world on x.com — makes all X API calls, reads cookies, discovers bearer token |
| `bridge.js` | ISOLATED world relay: `window.postMessage` → `chrome.runtime.sendMessage` |
| `background.js` | MV3 service worker — message routing, `chrome.storage.local` persistence, keepalive alarm |
| `popup/` | Side panel UI (vanilla JS/CSS) |

### Message flow

1. Popup sends to `background.js` via `chrome.runtime.sendMessage` (direction: `FROM_POPUP`)
2. `background.js` uses `chrome.scripting.executeScript` to inject into the x.com tab's MAIN world via `window.postMessage` (direction: `FROM_EXTENSION`)
3. `content.js` in MAIN world handles the message and replies via `window.postMessage` (direction: `FROM_PAGE`)
4. `bridge.js` in ISOLATED world receives the reply and forwards to `background.js` via `chrome.runtime.sendMessage`
5. `background.js` routes the reply back to the original popup caller via pending callbacks

### Auth

- **CSRF token**: read from `document.cookie` (`ct0` value) — same as X's web client
- **Bearer token**: discovered from page scripts/traffic using three strategies (inline scripts → external bundles → fetch interception), with a hardcoded fallback from X's public bundle
- **Transaction ID**: generated fresh for each write operation (`x-client-transaction-id` header, 66 random bytes → base64)

### APIs used (v1.1 REST)

| Endpoint | Purpose |
|----------|---------|
| `GET /1.1/friends/list.json` | Paginated following list with `skip_status=0` to get last tweet inline |
| `GET /1.1/statuses/user_timeline.json` | Per-user last original tweet date (enrichment) |
| `POST /1.1/friendships/destroy.json` | Unfollow (one at a time, 2s delay) |

### Data classification

Users are bucketed into:
- **No tweets** — `statusesCount === 0`
- **Unknown** — checked but no date returned (restricted/suspended account)
- **Inactive** — last tweet older than threshold (configurable: 30/90/180/365/custom days)
- **Active** — last tweet within threshold

### Storage (`chrome.storage.local`)

- `followingList` — full user array with enrichment data
- `fetchedAt` — timestamp of last fetch
- `fetchProgress` / `enrichProgress` / `unfollowProgress` — streaming progress for poll-based UI updates
- `debugLogs` — recent debug entries (inspect via DevTools → Application)

### Keepalive

Chrome MV3 terminates idle service workers after ~30s. A repeating alarm fires every ~24s to keep it alive. The popup also has automatic retry logic (2 retries, 350ms delay) when the service worker is freshly woken.

### Rate limits

Handled automatically with exponential backoff. 429 triggers a pause + countdown. Partial progress is persisted to `chrome.storage.local` on every 10th enrichment user and whenever fetch/enrich is cancelled.

## Testing

No test framework. Manual testing:
1. Load unpacked at `chrome://extensions`
2. Open x.com, log in, ensure timeline loads
3. Click extension → side panel opens
4. "Load Following" → browse tabs → select accounts → "Unfollow Selected"
