// entry point - coordinates all components
// inject interceptor immediately before X makes API calls
(function() {
  const script = document.createElement('script');
  script.src = window.xflagBrowser.runtime.getURL('content-scripts/interceptor.js');
  script.onload = function() {
    this.remove();
  };
  (document.head || document.documentElement).appendChild(script);
  console.log('[xflags] Interceptor injected (immediate)');
})();

(async function() {
  console.log('[xflags] Extension initializing...');

  let extensionEnabled = true;
  const ENABLED_KEY = 'xflag_enabled';

  /**
   * Map for O(1) lookup of tweet elements by username
   * Structure: Map<screenName, Set<HTMLElement>>
   * @type {Map<string, Set<HTMLElement>>}
   */
  const usernameElementMap = new Map();

  /**
   * Register a tweet element for a username
   * @param {string} screenName - X username
   * @param {HTMLElement} element - Tweet or UserCell element
   */
  function registerUsernameElement(screenName, element) {
    if (!usernameElementMap.has(screenName)) {
      usernameElementMap.set(screenName, new Set());
    }
    usernameElementMap.get(screenName).add(element);
  }

  /**
   * Get all tweet elements for a username (O(1) lookup)
   * @param {string} screenName - X username
   * @returns {Set<HTMLElement>} Set of tweet elements
   */
  function getElementsForUsername(screenName) {
    return usernameElementMap.get(screenName) || new Set();
  }

  /**
   * Clean up disconnected elements from the map
   * Call periodically to prevent memory leaks
   */
  function cleanupDisconnectedElements() {
    for (const [screenName, elements] of usernameElementMap.entries()) {
      for (const element of elements) {
        if (!document.contains(element)) {
          elements.delete(element);
        }
      }
      if (elements.size === 0) {
        usernameElementMap.delete(screenName);
      }
    }
  }

  // Run cleanup every 30 seconds
  setInterval(cleanupDisconnectedElements, 30000);

  async function loadEnabledState() {
    try {
      const enabled = await window.xflagBrowser.storage.get(ENABLED_KEY);
      extensionEnabled = enabled !== undefined ? enabled : true;
      console.log(`[xflags] Extension enabled: ${extensionEnabled}`);
    } catch (error) {
      console.error('[xflags] Error loading enabled state:', error);
      extensionEnabled = true;
    }
  }

  /**
   * Validate incoming postMessage structure
   * Prevents malicious page scripts from sending malformed messages
   * @param {Object} data - Message data
   * @param {string} expectedType - Expected message type
   * @returns {boolean} True if valid
   */
  function isValidMessage(data, expectedType) {
    if (!data || typeof data !== 'object') {
      return false;
    }
    if (data.type !== expectedType) {
      return false;
    }
    return true;
  }

  /**
   * Validate XFLAG_COUNTRY_DATA message structure
   * @param {Object} data - Message data
   * @returns {boolean} True if structure is valid
   */
  function isValidCountryDataMessage(data) {
    if (!isValidMessage(data, 'XFLAG_COUNTRY_DATA')) {
      return false;
    }
    // screenName must be a non-empty string
    if (typeof data.screenName !== 'string' || data.screenName.length === 0) {
      return false;
    }
    // screenName should be a valid username format (alphanumeric and underscore, max 15 chars)
    if (!/^[a-zA-Z0-9_]{1,15}$/.test(data.screenName)) {
      return false;
    }
    // location must be a string if present
    if (data.location !== undefined && data.location !== null && typeof data.location !== 'string') {
      return false;
    }
    return true;
  }

  /**
   * Validate XFLAG_FETCH_RESPONSE message structure
   * @param {Object} data - Message data
   * @returns {boolean} True if structure is valid
   */
  function isValidFetchResponseMessage(data) {
    if (!isValidMessage(data, 'XFLAG_FETCH_RESPONSE')) {
      return false;
    }
    if (typeof data.screenName !== 'string' || data.screenName.length === 0) {
      return false;
    }
    if (!/^[a-zA-Z0-9_]{1,15}$/.test(data.screenName)) {
      return false;
    }
    return true;
  }

  /**
   * Validate XFLAG_HEADERS_CAPTURED message structure
   * @param {Object} data - Message data
   * @returns {boolean} True if structure is valid
   */
  function isValidHeadersMessage(data) {
    if (!isValidMessage(data, 'XFLAG_HEADERS_CAPTURED')) {
      return false;
    }
    if (!data.headers || typeof data.headers !== 'object') {
      return false;
    }
    // Must have authorization header
    if (typeof data.headers.authorization !== 'string') {
      return false;
    }
    return true;
  }

  // handle messages from interceptor and active fetcher
  function setupMessageListener() {
    window.addEventListener('message', (event) => {
      // Security: Only accept messages from same window
      if (event.source !== window) return;

      // Security: Verify origin matches current page
      // This provides defense-in-depth against cross-origin attacks
      if (event.origin !== window.location.origin) {
        console.warn('[xflags] Rejected message from unexpected origin:', event.origin);
        return;
      }

      const data = event.data;

      // Early exit if not an xflag message
      if (!data || typeof data !== 'object' || !data.type || !data.type.startsWith('XFLAG_')) {
        return;
      }

      try {
        if (data.type === 'XFLAG_COUNTRY_DATA') {
          if (!isValidCountryDataMessage(data)) {
            console.warn('[xflags] Invalid XFLAG_COUNTRY_DATA message structure');
            return;
          }

          const { screenName, location, accurate } = data;

          if (screenName && location) {
            window.xflagCache.set(screenName, location, accurate);
            renderFlagsForUsername(screenName, { location, accurate });
          }
        }

        if (data.type === 'XFLAG_FETCH_RESPONSE') {
          if (!isValidFetchResponseMessage(data)) {
            console.warn('[xflags] Invalid XFLAG_FETCH_RESPONSE message structure');
            return;
          }

          const { screenName, location, accurate } = data;

          if (screenName && location) {
            window.xflagCache.set(screenName, location, accurate);
            renderFlagsForUsername(screenName, { location, accurate });
          } else if (screenName && location === null) {
            clearLoadingFlagsForUsername(screenName);
          }
        }

        if (data.type === 'XFLAG_HEADERS_CAPTURED') {
          if (!isValidHeadersMessage(data)) {
            console.warn('[xflags] Invalid XFLAG_HEADERS_CAPTURED message structure');
            return;
          }

          const { headers } = data;
          if (headers && window.xflagFetcher) {
            window.xflagFetcher.setHeaders(headers);
          }
        }
      } catch (error) {
        console.error('[xflags] Error processing message:', error);
      }
    });

    console.log('[xflags] Message listener active (passive + active fetching)');
  }

  /**
   * Render flags for all elements associated with a username
   * Uses usernameElementMap for O(1) lookup when available,
   * falls back to DOM query for elements not yet registered
   * @param {string} screenName - X username
   * @param {Object} countryData - Location data
   */
  function renderFlagsForUsername(screenName, countryData) {
    // First, try O(1) lookup from our map
    const registeredElements = getElementsForUsername(screenName);

    if (registeredElements.size > 0) {
      for (const tweet of registeredElements) {
        if (document.contains(tweet)) {
          window.xflagRenderer.renderFlag(tweet, screenName, countryData);
        }
      }
    }

    // Also do a DOM query to catch any elements not yet registered
    // This handles the case where data arrives before observer processes the element
    const tweets = document.querySelectorAll('article[data-testid="tweet"], [data-testid="UserCell"]');

    for (const tweet of tweets) {
      const username = window.xflagObserver.extractUsername(tweet);
      if (username === screenName) {
        // Register for future O(1) lookups
        registerUsernameElement(screenName, tweet);
        window.xflagRenderer.renderFlag(tweet, screenName, countryData);
      }
    }
  }

  /**
   * Clear loading flags for a username when fetch returns no data
   * @param {string} screenName - X username
   */
  function clearLoadingFlagsForUsername(screenName) {
    // Try O(1) lookup first
    const registeredElements = getElementsForUsername(screenName);

    for (const tweet of registeredElements) {
      if (document.contains(tweet)) {
        const loadingFlag = tweet.querySelector('[data-xflag][data-loading="true"]');
        if (loadingFlag) {
          loadingFlag.remove();
          console.log(`[xflags] Removed loading flag for @${screenName}`);
        }
      }
    }

    // Fallback to DOM query
    const tweets = document.querySelectorAll('article[data-testid="tweet"], [data-testid="UserCell"]');

    for (const tweet of tweets) {
      const username = window.xflagObserver.extractUsername(tweet);
      if (username === screenName) {
        const loadingFlag = tweet.querySelector('[data-xflag][data-loading="true"]');
        if (loadingFlag) {
          loadingFlag.remove();
          console.log(`[xflags] Removed loading flag for @${screenName}`);
        }
      }
    }
  }

  /**
   * Message handlers for popup -> content script communication
   * Using object lookup pattern for cleaner message routing
   */
  const messageHandlers = {
    extensionToggle: (request) => {
      extensionEnabled = request.enabled;

      if (extensionEnabled) {
        console.log('[xflags] Extension ENABLED via popup');
        window.xflagRenderer.showAllFlags();
        window.xflagObserver.resume();
        if (window.xflagFetcher) {
          window.xflagFetcher.resume();
        }
        console.log('[xflags] Flags restored, fetching resumed for non-cached users');
      } else {
        console.log('[xflags] Extension DISABLED via popup');
        window.xflagRenderer.hideAllFlags();
        window.xflagObserver.pause();
        if (window.xflagFetcher) {
          window.xflagFetcher.pause();
        }
        console.log('[xflags] Flags hidden, fetching paused');
      }
      return { success: true };
    },

    clearCache: async () => {
      await window.xflagCache.clear();
      window.xflagRenderer.removeAllFlags();
      return { success: true };
    },

    updateTTL: async (request) => {
      await window.xflagCache.setTTL(request.days);
      return { success: true };
    },

    startTest: async () => {
      if (window.xflagLogger) {
        await window.xflagLogger.startNewTest();
      }
      return { success: true };
    },

    getTestStats: () => {
      if (window.xflagLogger) {
        return { stats: window.xflagLogger.getStats() };
      }
      return { stats: null };
    },

    exportLog: () => {
      if (window.xflagLogger) {
        return { log: window.xflagLogger.exportLog() };
      }
      return { log: null };
    },

    getConsoleLogs: () => {
      if (window.xflagConsole) {
        return {
          logs: window.xflagConsole.getLogs(),
          stats: window.xflagConsole.getStats()
        };
      }
      return { logs: [], stats: {} };
    },

    clearConsoleLogs: () => {
      if (window.xflagConsole) {
        window.xflagConsole.clear();
      }
      return { success: true };
    }
  };

  /**
   * Set up message listener for popup communication
   */
  window.xflagBrowser.runtime.onMessage.addListener((request, sender, sendResponse) => {
    try {
      // Validate request structure
      if (!request || typeof request !== 'object' || !request.type) {
        console.warn('[xflags] Invalid message request structure');
        return false;
      }

      const handler = messageHandlers[request.type];

      if (!handler) {
        console.warn(`[xflags] Unknown message type: ${request.type}`);
        return false;
      }

      // Handle async handlers properly
      const result = handler(request);

      if (result instanceof Promise) {
        result
          .then(response => sendResponse(response))
          .catch(error => {
            console.error(`[xflags] Error in handler ${request.type}:`, error);
            sendResponse({ success: false, error: error.message });
          });
        return true; // Keep channel open for async response
      }

      // Sync handler
      sendResponse(result);
      return false;
    } catch (error) {
      console.error('[xflags] Error in message listener:', error);
      sendResponse({ success: false, error: error.message });
      return false;
    }
  });

  // Expose registerUsernameElement for observer to use
  window.xflagRegisterElement = registerUsernameElement;

  await loadEnabledState();

  if (!extensionEnabled) {
    console.log('[xflags] Extension is disabled');
    return;
  }

  // load cache
  await window.xflagCache.load();

  // load logger
  if (window.xflagLogger) {
    await window.xflagLogger.load();
  }

  // set up message listener (interceptor already injected at top)
  setupMessageListener();

  // start observer
  setTimeout(() => {
    window.xflagObserver.start();
  }, 1000);

  console.log('[xflags] Extension initialized successfully');
})();
