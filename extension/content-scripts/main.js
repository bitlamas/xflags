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

  // handle messages from interceptor and active fetcher
  function setupMessageListener() {
    window.addEventListener('message', (event) => {
      if (event.source !== window) return;

      if (event.data && event.data.type === 'XFLAG_COUNTRY_DATA') {
        const { screenName, location, accurate } = event.data;

        if (screenName && location) {
          window.xflagCache.set(screenName, location, accurate);

          // find and render flags for this username
          renderFlagsForUsername(screenName, { location, accurate });
        }
      }

      if (event.data && event.data.type === 'XFLAG_FETCH_RESPONSE') {
        const { screenName, location, accurate } = event.data;

        if (screenName && location) {
          window.xflagCache.set(screenName, location, accurate);

          renderFlagsForUsername(screenName, { location, accurate });
        } else if (screenName && location === null) {
          clearLoadingFlagsForUsername(screenName);
        }
      }

      if (event.data && event.data.type === 'XFLAG_HEADERS_CAPTURED') {
        const { headers } = event.data;
        if (headers && window.xflagFetcher) {
          window.xflagFetcher.setHeaders(headers);
        }
      }
    });

    console.log('[xflags] Message listener active (passive + active fetching)');
  }

  function renderFlagsForUsername(screenName, countryData) {
    const tweets = document.querySelectorAll('article[data-testid="tweet"], [data-testid="UserCell"]');

    for (const tweet of tweets) {
      const username = window.xflagObserver.extractUsername(tweet);
      if (username === screenName) {
        window.xflagRenderer.renderFlag(tweet, screenName, countryData);
      }
    }
  }

  function clearLoadingFlagsForUsername(screenName) {
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

  window.xflagBrowser.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === 'extensionToggle') {
      extensionEnabled = request.enabled;

      if (extensionEnabled) {
        console.log('[xflags] ✓ Extension ENABLED via popup');

        window.xflagRenderer.showAllFlags();

        window.xflagObserver.resume();

        if (window.xflagFetcher) {
          window.xflagFetcher.resume();
        }

        console.log('[xflags] Flags restored, fetching resumed for non-cached users');
      } else {
        console.log('[xflags] ✗ Extension DISABLED via popup');

        window.xflagRenderer.hideAllFlags();

        window.xflagObserver.pause();

        if (window.xflagFetcher) {
          window.xflagFetcher.pause();
        }

        console.log('[xflags] Flags hidden, fetching paused');
      }
    }

    if (request.type === 'clearCache') {
      window.xflagCache.clear().then(() => {
        window.xflagRenderer.removeAllFlags();
        sendResponse({ success: true });
      });
      return true;
    }

    if (request.type === 'updateTTL') {
      window.xflagCache.setTTL(request.days).then(() => {
        sendResponse({ success: true });
      });
      return true;
    }

    if (request.type === 'startTest') {
      if (window.xflagLogger) {
        window.xflagLogger.startNewTest().then(() => {
          sendResponse({ success: true });
        });
      }
      return true;
    }

    if (request.type === 'getTestStats') {
      if (window.xflagLogger) {
        const stats = window.xflagLogger.getStats();
        sendResponse({ stats: stats });
      } else {
        sendResponse({ stats: null });
      }
      return true;
    }

    if (request.type === 'exportLog') {
      if (window.xflagLogger) {
        const log = window.xflagLogger.exportLog();
        sendResponse({ log: log });
      } else {
        sendResponse({ log: null });
      }
      return true;
    }

    if (request.type === 'getConsoleLogs') {
      if (window.xflagConsole) {
        const logs = window.xflagConsole.getLogs();
        const stats = window.xflagConsole.getStats();
        sendResponse({ logs: logs, stats: stats });
      } else {
        sendResponse({ logs: [], stats: {} });
      }
      return true;
    }

    if (request.type === 'clearConsoleLogs') {
      if (window.xflagConsole) {
        window.xflagConsole.clear();
        sendResponse({ success: true });
      }
      return true;
    }

    return false;
  });

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

  console.log('[xflags] Extension initialized successfully ✓');
})();
