/**
 * background.js — Manifest V3 Service Worker
 *
 * - Side panel on toolbar click
 * - Relay messages between popup (side panel) and content script
 * - Cache following list and progress in chrome.storage.local
 * - Append debug logs to storage (inspect via DevTools → Application if needed)
 */

// ---------------------------------------------------------------------------
// Side panel setup (Chrome 114+)
// ---------------------------------------------------------------------------
async function setupSidePanel() {
  if (chrome.sidePanel) {
    try {
      await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
    } catch (e) {
      console.warn('[XUnfollower] sidePanel API unavailable:', e);
    }
  }
}

chrome.runtime.onInstalled.addListener(setupSidePanel);
setupSidePanel(); // also re-run on service worker restart

// ---------------------------------------------------------------------------
// Keepalive — Chrome terminates idle MV3 service workers after ~30 seconds.
// A repeating alarm wakes it up every 25 seconds so the panel never sees a
// "context invalidated" disconnect during normal use.
// ---------------------------------------------------------------------------
chrome.alarms.create('keepalive', { periodInMinutes: 0.4 }); // ~24 s
chrome.alarms.onAlarm.addListener(() => { /* waking up is enough */ });

// ---------------------------------------------------------------------------
// Debug logging — stored in chrome.storage.local, key: "debugLogs"
// ---------------------------------------------------------------------------
const MAX_LOGS = 400;

const logQueue = [];
let logWriting = false;

async function flushLogQueue() {
  if (logWriting || logQueue.length === 0) return;
  logWriting = true;
  try {
    const batch = logQueue.splice(0, logQueue.length);
    const data = await chrome.storage.local.get('debugLogs');
    const logs = Array.isArray(data.debugLogs) ? data.debugLogs : [];
    logs.push(...batch);
    if (logs.length > MAX_LOGS) logs.splice(0, logs.length - MAX_LOGS);
    await chrome.storage.local.set({ debugLogs: logs });
  } catch (e) {
    console.error('[XUnfollower] Failed to store log:', e);
  } finally {
    logWriting = false;
    if (logQueue.length > 0) flushLogQueue();
  }
}

function appendLog(entry) {
  logQueue.push(entry);
  flushLogQueue();
}

function bgLog(level, message, data) {
  const entry = { ts: Date.now(), source: 'bg', level, message };
  if (data !== undefined) entry.data = data;
  console[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log'](
    `[XUnfollower:bg] ${message}`, data ?? ''
  );
  appendLog(entry);
}

// ---------------------------------------------------------------------------
// Message ID counter — persisted in session storage to survive SW restarts
// ---------------------------------------------------------------------------
let msgCounter = 0;
async function initMsgCounter() {
  try {
    const data = await chrome.storage.session.get('msgCounter');
    msgCounter = (data.msgCounter || 0) + 1000;
  } catch (_) {
    msgCounter = Math.floor(Math.random() * 100000);
  }
}
function nextId() {
  const id = `msg_${++msgCounter}_${Date.now()}`;
  try { chrome.storage.session.set({ msgCounter }); } catch (_) {}
  return id;
}
initMsgCounter();

// ---------------------------------------------------------------------------
// Pending callbacks keyed by message id
// Each entry: { fn: (reply) => bool, cancel: () => void }
// ---------------------------------------------------------------------------
const pendingCallbacks = new Map();

// Track which pending message ID belongs to each tab (for long-running ops).
// When the tab navigates, we cancel the hung promise so the UI doesn't freeze.
const activeTabOps = new Map(); // tabId → message id

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== 'loading') return;
  const msgId = activeTabOps.get(tabId);
  if (!msgId) return;
  if (changeInfo.url) {
    const isXDomain = changeInfo.url.startsWith('https://x.com') || changeInfo.url.startsWith('https://twitter.com');
    if (isXDomain) {
      bgLog('info', 'Tab navigated within x.com — skipping cancel for SPA navigation', { tabId, url: changeInfo.url });
      return;
    }
  }
  cancelTabOp(tabId, msgId, 'Tab navigated during active operation — cancelling');
});

chrome.tabs.onRemoved.addListener((tabId) => {
  const msgId = activeTabOps.get(tabId);
  if (!msgId) return;
  cancelTabOp(tabId, msgId, 'Tab closed during active operation — cancelling');
});

function cancelTabOp(tabId, msgId, reason) {
  bgLog('warn', reason, { tabId, msgId });
  const entry = pendingCallbacks.get(msgId);
  if (entry) {
    pendingCallbacks.delete(msgId);
    activeTabOps.delete(tabId);
    entry.cancel();
  }
}

// ---------------------------------------------------------------------------
// Pick an x.com tab: active tab if any, otherwise first match
// ---------------------------------------------------------------------------
async function getXTab() {
  const tabs = await chrome.tabs.query({
    url: ['https://x.com/*', 'https://twitter.com/*'],
  });
  if (tabs.length === 0) return null;
  return tabs.find((t) => t.active) ?? tabs[0];
}

// ---------------------------------------------------------------------------
// Send a message to content.js via executeScript → window.postMessage
// ---------------------------------------------------------------------------
function sendToContent(tabId, type, payload = {}, onStream = null) {
  return new Promise((resolve, reject) => {
    const id = nextId();

    const entry = {
      fn: (reply) => {
        const isStream =
          reply.type === 'FETCH_PROGRESS' ||
          reply.type === 'ENRICH_PROGRESS' ||
          (reply.type === 'UNFOLLOW_PROGRESS' &&
            reply.progress?.phase !== 'unfollow_done' &&
            reply.progress?.phase !== 'unfollow_cancelled');

        if (isStream) {
          onStream?.(reply);
          return false;
        }

        pendingCallbacks.delete(id);
        if (activeTabOps.get(tabId) === id) activeTabOps.delete(tabId);
        if (reply.type === 'ERROR') {
          reject(new Error(reply.error));
        } else {
          resolve(reply);
        }
        return true;
      },
      cancel: () => {
        resolve({ type: 'FETCH_CANCELLED' });
      },
    };

    pendingCallbacks.set(id, entry);

    // Register long-running ops so the tab listener can cancel them on navigation.
    if (type === 'FETCH_FOLLOWING' || type === 'ENRICH_ACTIVITY') {
      activeTabOps.set(tabId, id);
    }

    chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: (msgPayload) => {
        window.postMessage({ direction: 'FROM_EXTENSION', ...msgPayload }, '*');
      },
      args: [{ id, type, ...payload }],
    }).catch((err) => {
      pendingCallbacks.delete(id);
      if (activeTabOps.get(tabId) === id) activeTabOps.delete(tabId);
      const msg = err.message || String(err);
      // "Extension context invalidated" means the service worker was recycled —
      // surface a friendly message rather than a raw Chrome internal error.
      const friendly = msg.includes('context invalidated') || msg.includes('Extension context')
        ? 'Extension was reloaded or updated. Please close and reopen the side panel.'
        : msg;
      bgLog('error', `executeScript failed for ${type}`, { message: msg });
      reject(new Error(friendly));
    });
  });
}

// ---------------------------------------------------------------------------
// Incoming messages: FROM_PAGE (bridge.js) and FROM_POPUP (popup.js)
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.direction === 'FROM_PAGE') {
    // Debug log entries from content.js
    if (message.type === 'LOG') {
      appendLog({ ts: message.ts, source: 'content', level: message.level, message: message.message, data: message.data });
      return false;
    }

    const cb = pendingCallbacks.get(message.id);
    if (cb) cb.fn(message);
    return false;
  }

  if (message.direction === 'FROM_POPUP') {
    handlePanelMessage(message, sendResponse);
    return true; // keep channel open for async
  }
});

// ---------------------------------------------------------------------------
// Panel message handlers
// ---------------------------------------------------------------------------
async function handlePanelMessage(message, sendResponse) {
  try {
    switch (message.type) {

      case 'PING': {
        const tab = await getXTab();
        if (!tab) {
          bgLog('warn', 'PING: no x.com tab found');
          sendResponse({ success: false, error: 'No x.com tab open. Please open x.com first.' });
          return;
        }
        bgLog('info', 'PING → content', { tabId: tab.id, url: tab.url });
        const reply = await sendToContent(tab.id, 'PING');
        bgLog('info', 'PING ← content', { loggedIn: reply.loggedIn, userId: reply.userId, tokenReady: reply.tokenReady });
        sendResponse({ success: true, ...reply, tabId: tab.id });
        break;
      }

      case 'FETCH_FOLLOWING': {
        const tab = await getXTab();
        if (!tab) {
          sendResponse({ success: false, error: 'No x.com tab open.' });
          return;
        }
        bgLog('info', 'FETCH_FOLLOWING started', { tabId: tab.id });

        const reply = await sendToContent(tab.id, 'FETCH_FOLLOWING', {}, async (streamMsg) => {
          await chrome.storage.local.set({ fetchProgress: streamMsg.progress });
        });

        if (reply.type === 'FETCH_FOLLOWING_DONE') {
          const freshUsers = reply.users;
          bgLog('info', 'FETCH_FOLLOWING done', { count: freshUsers.length });

          // Merge with cached list — preserve enrichment data for existing users
          const cached = await chrome.storage.local.get('followingList');
          const existing = cached.followingList || [];
          const existingMap = new Map(existing.map((u) => [u.id, u]));

          let newCount = 0;
          const merged = freshUsers.map((u) => {
            const prev = existingMap.get(u.id);
            if (prev) {
              // If we got fresh activity data from skip_status=0 (original post detected),
              // use it — it's more up-to-date than the cache.
              // Otherwise keep the cached enrichment data (could be from a deeper API call).
              const hasFreshData = u.activityChecked !== undefined;
              return {
                ...u,
                lastTweetAt: hasFreshData ? u.lastTweetAt : prev.lastTweetAt,
                activityChecked: hasFreshData ? u.activityChecked : prev.activityChecked,
              };
            }
            newCount++;
            return u;
          });

          bgLog('info', 'FETCH_FOLLOWING merged', { total: merged.length, newUsers: newCount });
          await chrome.storage.local.set({ followingList: merged, fetchedAt: Date.now() });
          sendResponse({ success: true, users: merged, newCount });
        } else {
          bgLog('warn', 'FETCH_FOLLOWING cancelled');
          sendResponse({ success: false, cancelled: true });
        }
        break;
      }

      case 'ENRICH_ACTIVITY': {
        const tab = await getXTab();
        if (!tab) {
          sendResponse({ success: false, error: 'No x.com tab open.' });
          return;
        }
        const { users } = message;
        bgLog('info', 'ENRICH_ACTIVITY started', { count: users?.length });

        // Working copy of the full list — updated incrementally so that a tab
        // refresh or cancel doesn't lose all progress.
        const workingUsers = users.map((u) => ({ ...u }));
        const userIdxMap = new Map(workingUsers.map((u, i) => [u.id, i]));

        const reply = await sendToContent(tab.id, 'ENRICH_ACTIVITY', { users }, async (streamMsg) => {
          const p = streamMsg.progress;
          await chrome.storage.local.set({ enrichProgress: p });

          // Persist each enriched user immediately and do a full list save every
          // 10 users so progress survives a tab refresh or cancel.
          if (p.phase === 'enrich' && p.user) {
            const i = userIdxMap.get(p.user.id);
            if (i !== undefined) workingUsers[i] = { ...workingUsers[i], ...p.user };
            if (p.index % 10 === 0 || p.index === p.total - 1) {
              await chrome.storage.local.set({ followingList: workingUsers });
            }
          }
        });

        if (reply.type === 'ENRICH_DONE') {
          bgLog('info', 'ENRICH_ACTIVITY done', { count: reply.users?.length });
          await chrome.storage.local.set({ followingList: reply.users });
          sendResponse({ success: true, users: reply.users });
        } else {
          // Cancelled or tab navigated — partial progress is already in storage.
          bgLog('warn', 'ENRICH_ACTIVITY cancelled, partial data saved', { saved: workingUsers.length });
          await chrome.storage.local.set({ followingList: workingUsers });
          sendResponse({ success: false, cancelled: true });
        }
        break;
      }

      case 'UNFOLLOW': {
        const tab = await getXTab();
        if (!tab) {
          sendResponse({ success: false, error: 'No x.com tab open.' });
          return;
        }
        const { userIds } = message;
        bgLog('info', 'UNFOLLOW started', { count: userIds?.length });

        const reply = await sendToContent(tab.id, 'UNFOLLOW', { userIds }, async (streamMsg) => {
          await chrome.storage.local.set({ unfollowProgress: streamMsg.progress });
        });

        bgLog('info', 'UNFOLLOW done', reply.progress);
        sendResponse({ success: true, progress: reply.progress });
        break;
      }

      case 'CANCEL_FETCH': {
        const tab = await getXTab();
        if (tab) await sendToContent(tab.id, 'CANCEL_FETCH');
        sendResponse({ success: true });
        break;
      }

      case 'CANCEL_UNFOLLOW': {
        const tab = await getXTab();
        if (tab) await sendToContent(tab.id, 'CANCEL_UNFOLLOW');
        sendResponse({ success: true });
        break;
      }

      case 'GET_CACHED': {
        const data = await chrome.storage.local.get(['followingList', 'fetchedAt']);
        sendResponse({ success: true, ...data });
        break;
      }

      case 'CLEAR_CACHE': {
        await chrome.storage.local.remove(['followingList', 'fetchedAt', 'fetchProgress', 'enrichProgress', 'unfollowProgress']);
        sendResponse({ success: true });
        break;
      }

      case 'REMOVE_UNFOLLOWED': {
        const { userIds } = message;
        const data = await chrome.storage.local.get('followingList');
        const updated = (data.followingList || []).filter((u) => !userIds.includes(u.id));
        await chrome.storage.local.set({ followingList: updated });
        sendResponse({ success: true, users: updated });
        break;
      }

      default:
        sendResponse({ success: false, error: `Unknown type: ${message.type}` });
    }
  } catch (err) {
    bgLog('error', `handlePanelMessage error in ${message.type}`, { message: err.message, stack: err.stack });
    sendResponse({ success: false, error: err.message || String(err) });
  }
}
