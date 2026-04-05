/**
 * bridge.js — Runs in ISOLATED world on x.com.
 * Listens for window.postMessage replies from content.js (MAIN world)
 * and forwards them to background.js via chrome.runtime.sendMessage.
 */
window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  const msg = event.data;
  if (!msg || msg.direction !== 'FROM_PAGE') return;

  // If the extension context has been invalidated (service worker reloaded,
  // extension disabled/reloaded, etc.), chrome.runtime or its id may be
  // missing. In that case, just drop the message instead of throwing.
  if (!chrome.runtime || !chrome.runtime.id || typeof chrome.runtime.sendMessage !== 'function') {
    return;
  }

  chrome.runtime.sendMessage(msg);
});
