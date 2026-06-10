/**
 * StateSync Event Broker module for extension.
 * Event-driven message broadcasting between background and popup.
 */

const StateSync = {
  /**
   * Broadcast message to active extension runtime scripts.
   * @param {string} type 
   * @param {any} data 
   */
  broadcastState(type, data) {
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
      try {
        chrome.runtime.sendMessage({
          direction: 'STATE_SYNC',
          type,
          data
        });
      } catch (e) {
        // Suppress errors when popup is closed/not listening
      }
    }
  },

  /**
   * Subscribe to state broadcast events.
   * @param {string} type 
   * @param {function} callback 
   * @returns {function} unsubscribe function
   */
  onMessage(type, callback) {
    const listener = (message) => {
      if (message && message.direction === 'STATE_SYNC' && message.type === type) {
        callback(message.data);
      }
    };
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
      chrome.runtime.onMessage.addListener(listener);
    }
    return () => {
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
        chrome.runtime.onMessage.removeListener(listener);
      }
    };
  }
};

if (typeof module !== 'undefined') {
  module.exports = StateSync;
}
