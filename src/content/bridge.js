/**
 * bridge.js — Runs in ISOLATED world on x.com.
 * Listens for window.postMessage replies from content.js (MAIN world)
 * and forwards them to background.js via chrome.runtime.sendMessage.
 */

// If the extension context has been invalidated (service worker reloaded,
// extension disabled/reloaded, etc.), chrome.runtime or its id may be
// missing. In that case, just drop the message instead of throwing.
if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id) {
  
  // Relay messages from MAIN (window.postMessage) to BACKGROUND/POPUP
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.direction !== 'CROSS_WORLD_MSG') return;
    
    const { envelope } = msg;
    if (!envelope) return;

    if (envelope.target === 'BACKGROUND' || envelope.target === 'POPUP') {
      if (chrome.runtime && chrome.runtime.sendMessage) {
        try {
          chrome.runtime.sendMessage({ direction: 'CROSS_WORLD_MSG', envelope });
        } catch (_) {}
      }
    }
  });

  // Relay messages from BACKGROUND/POPUP (chrome.runtime.onMessage) to MAIN
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.direction !== 'CROSS_WORLD_MSG') return;

    const { envelope } = msg;
    if (!envelope) return;

    if (envelope.target === 'MAIN') {
      window.postMessage({ direction: 'CROSS_WORLD_MSG', envelope }, location.origin);
    }
  });
}

