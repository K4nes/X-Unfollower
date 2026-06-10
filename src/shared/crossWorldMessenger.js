/**
 * CrossWorldMessenger - Handles messaging between Main execution context,
 * Isolated context, Background SW, and Popup.
 */

class CrossWorldMessenger {
  /**
   * Send a structured message envelope to a target context.
   * @param {string} target 'MAIN' | 'ISOLATED' | 'BACKGROUND' | 'POPUP'
   * @param {string} action
   * @param {any} payload
   * @param {object} options
   * @returns {Promise<any>}
   */
  static send(target, action, payload = {}, options = {}) {
    const id = `msg_${Math.random().toString(36).substr(2, 9)}_${Date.now()}`;
    const source = CrossWorldMessenger.determineCurrentContext();
    const envelope = {
      id,
      source,
      target,
      action,
      payload
    };

    return new Promise((resolve, reject) => {
      let timeoutId;
      const cleanup = () => {
        if (timeoutId) clearTimeout(timeoutId);
        CrossWorldMessenger.removeResponseListener(id);
      };

      if (options.timeoutMs && options.timeoutMs > 0) {
        timeoutId = setTimeout(() => {
          cleanup();
          reject(new Error(`Message timeout after ${options.timeoutMs}ms`));
        }, options.timeoutMs);
      }

      CrossWorldMessenger.registerResponseListener(id, (responseEnvelope) => {
        cleanup();
        if (responseEnvelope.error) {
          reject(new Error(responseEnvelope.error));
        } else {
          resolve(responseEnvelope.payload);
        }
      });

      CrossWorldMessenger.dispatchEnvelope(envelope);
    });
  }

  /**
   * Listen for incoming envelopes matching specific action patterns.
   * @param {string} action 
   * @param {function} handler 
   * @returns {function} unsubscribe callback
   */
  static on(action, handler) {
    const listener = async (envelope) => {
      if (envelope && envelope.action === action && envelope.target === CrossWorldMessenger.determineCurrentContext()) {
        try {
          const result = await handler(envelope.payload);
          CrossWorldMessenger.dispatchEnvelope({
            id: envelope.id,
            source: envelope.target,
            target: envelope.source,
            action: `${action}_REPLY`,
            payload: result
          });
        } catch (e) {
          CrossWorldMessenger.dispatchEnvelope({
            id: envelope.id,
            source: envelope.target,
            target: envelope.source,
            action: `${action}_REPLY`,
            payload: {},
            error: e.message
          });
        }
      }
    };

    CrossWorldMessenger.listeners.push(listener);
    return () => {
      CrossWorldMessenger.listeners = CrossWorldMessenger.listeners.filter(x => x !== listener);
    };
  }

  static determineCurrentContext() {
    if (typeof window === 'undefined') {
      return 'BACKGROUND';
    }
    // extension popups or sidepanels have chrome.extension APIs
    if (typeof chrome !== 'undefined' && chrome.extension) {
      return 'POPUP';
    }
    // Main world vs isolated world content script:
    // main world does not have access to chrome.runtime
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id) {
      return 'ISOLATED';
    }
    return 'MAIN';
  }

  static dispatchEnvelope(envelope) {
    const context = CrossWorldMessenger.determineCurrentContext();
    
    // In node test environment or if we have set a mock dispatcher:
    if (CrossWorldMessenger.mockDispatcher) {
      CrossWorldMessenger.mockDispatcher(envelope);
      return;
    }

    if (context === 'MAIN') {
      window.postMessage({ direction: 'CROSS_WORLD_MSG', envelope }, location.origin);
    } else if (context === 'ISOLATED') {
      if (envelope.target === 'BACKGROUND' || envelope.target === 'POPUP') {
        chrome.runtime.sendMessage({ direction: 'CROSS_WORLD_MSG', envelope });
      } else if (envelope.target === 'MAIN') {
        window.postMessage({ direction: 'CROSS_WORLD_MSG', envelope }, location.origin);
      }
    } else if (context === 'BACKGROUND' || context === 'POPUP') {
      if (envelope.target === 'ISOLATED' || envelope.target === 'MAIN') {
        if (typeof chrome !== 'undefined' && chrome.tabs) {
          chrome.tabs.query({
            url: ['https://x.com/*', 'https://twitter.com/*'],
          }, (tabs) => {
            const tab = (tabs && tabs.find((t) => t.active)) ?? (tabs && tabs[0]);
            if (tab && tab.id) {
              chrome.tabs.sendMessage(tab.id, { direction: 'CROSS_WORLD_MSG', envelope });
            } else {
              CrossWorldMessenger.handleIncomingEnvelope({
                id: envelope.id,
                source: 'BACKGROUND',
                target: envelope.source,
                action: `${envelope.action}_REPLY`,
                error: 'No active X.com tab found. Please open X.com first.'
              });
            }
          });
        } else {
          chrome.runtime.sendMessage({ direction: 'CROSS_WORLD_MSG', envelope });
        }
      } else {
        chrome.runtime.sendMessage({ direction: 'CROSS_WORLD_MSG', envelope });
      }
    }
  }

  static registerResponseListener(id, callback) {
    CrossWorldMessenger.responseListeners.set(id, callback);
  }

  static removeResponseListener(id) {
    CrossWorldMessenger.responseListeners.delete(id);
  }

  static handleIncomingEnvelope(envelope) {
    if (!envelope) return;
    
    // Check if this is a reply to an active sent request
    const responseCallback = CrossWorldMessenger.responseListeners.get(envelope.id);
    if (responseCallback && envelope.action.endsWith('_REPLY')) {
      responseCallback(envelope);
      return;
    }

    // Otherwise trigger handlers
    CrossWorldMessenger.listeners.forEach(handler => handler(envelope));
  }
}

CrossWorldMessenger.listeners = [];
CrossWorldMessenger.responseListeners = new Map();
CrossWorldMessenger.mockDispatcher = null;

// Hook listener events in real environment
if (typeof window !== 'undefined') {
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (msg && msg.direction === 'CROSS_WORLD_MSG') {
      CrossWorldMessenger.handleIncomingEnvelope(msg.envelope);
    }
  });
}
if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.direction === 'CROSS_WORLD_MSG') {
      CrossWorldMessenger.handleIncomingEnvelope(msg.envelope);
    }
  });
}

export default CrossWorldMessenger;
