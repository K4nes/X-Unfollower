# X Unfollow

> Find and unfollow inactive accounts on X — no API key or paid service.

**By [@firsdeka](https://x.com/firsdeka)**

## What it is

Chrome/Edge extension: loads who you follow, estimates last activity, lets you unfollow in bulk. Uses the same in-browser requests as x.com (internal REST APIs). Nothing is sent to a server you don’t already use.

## Install

Unpacked only (not in the Chrome Web Store yet).

1. Clone or download this repo.
2. Open `chrome://extensions` → turn on **Developer mode**.
3. **Load unpacked** → choose the `X-Unfollower` folder.
4. Pin **X Unfollow** from the extensions menu if you want it on the toolbar.

## Quick start

1. Open [x.com](https://x.com), log in, scroll a bit so the site loads (helps token capture).
2. Click the extension → **side panel** opens.
3. When the status shows logged in, set the **inactivity** threshold and click **Load Following**.
4. Use tabs (**No tweets**, **Unknown**, **Inactive**, **Active**), **Sort**, and checkboxes; **Unfollow Selected** runs one-by-one with delays. **Stop** cancels. Progress is saved if you cancel mid-fetch.

## How it’s built

| Piece | Role |
|--------|------|
| `content.js` (MAIN world, on x.com) | Cookies + X API: following list, timelines, unfollow, rate-limit waits |
| `bridge.js` (isolated world) | Relays `window.postMessage` ↔ extension runtime |
| `background.js` | Side panel, storage, tab pick, message routing |
| `popup/` | Side panel UI (vanilla JS/CSS) |

```
Side panel ──► background.js ──► bridge.js ──► content.js (x.com tab)
```

**APIs used (v1.1 REST):** `friends/list`, `statuses/user_timeline`, `friendships/destroy`. Auth: CSRF cookie + bearer token (discovered from page scripts / traffic, with a public fallback token from X’s own bundle).

## Rate limits

Handled automatically (pause + countdown, then resume). Activity checks run **5 concurrent requests** with rate-limit-aware throttling.

| Operation | Rough limit |
|-----------|-------------|
| Following list | ~15 pages (~3k accounts) / 15 min |
| Activity check | ~5 requests at a time; 900 / 15 min window; auto-pauses near limit |
| Unfollow | 1 every 2s; very high daily volume may risk flags from X |

Large lists can take several minutes; partial results stay in local storage if you cancel.

## Privacy & security

- **No extra servers** — traffic is your browser ↔ `x.com` (and `twitter.com` URLs).
- Tokens come from your session, same as the site.
- Data lives in **`chrome.storage.local`** only (with `unlimitedStorage` for large follow lists).
- Debug logs redact sensitive keys.
- `postMessage` calls use origin-scoped targets (not wildcards).
- No inline event handlers — all DOM binding via `addEventListener`.
- **Scan:** [VirusTotal report](https://www.virustotal.com/gui/file/8007fe3841f9b90777fe1f29461f2558843b255c52d6e3a2673835d882409320) for a published build (hash on that page).

## Notes

- An **x.com tab** must be open in that browser; the content script runs there.
- **Protected** accounts can’t be timeline-checked → **Unknown**, not auto-selected.
- **Zero tweets** → **No tweets** tab (separate from inactive/active).
- **Chrome / Edge:** yes · **Firefox / Safari:** no (MV3 side panel).

---

*Vanilla JS, Manifest V3, no npm dependencies.*
