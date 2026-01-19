// popup.js - Extension popup UI controller
//
// NOTE: This file runs in the popup context, which is separate from content scripts.
// The browser API detection here is duplicated from browser-compat.js because:
// - Popup context cannot share window.xflagBrowser from content scripts
// - The popup HTML only loads popup.js, not the full content script bundle
// - This is an intentional architectural decision for isolation

const ENABLED_KEY = 'xflag_enabled';
const CACHE_TTL_KEY = 'xflag_cache_ttl';
const CONSENT_KEY = 'xflag_consent_given';
const ERROR_LOG_ENABLED_KEY = 'xflag_error_log_enabled';
const DEFAULT_CACHE_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days
const REFRESH_INTERVAL = 2000; // 2 seconds

/**
 * Service Worker Message Types for error logging
 */
const SW_MESSAGE_TYPES = {
  ERROR_LOG: 'SW_ERROR_LOG',
  ERROR_GET_ALL: 'SW_ERROR_GET_ALL',
  ERROR_CLEAR: 'SW_ERROR_CLEAR',
  ERROR_EXPORT: 'SW_ERROR_EXPORT'
};

const isFirefox = typeof browser !== 'undefined';
const browserAPI = isFirefox ? browser : chrome;

// Store interval reference for cleanup
let refreshIntervalId = null;

// check consent on load
(async function() {
  const consentGiven = await checkConsent();

  if (!consentGiven) {
    showConsentScreen();
  } else {
    showMainUI();
    initializeMainUI();
  }
})();

async function checkConsent() {
  try {
    const result = isFirefox ?
      await browser.storage.local.get(CONSENT_KEY) :
      await new Promise(resolve => chrome.storage.local.get(CONSENT_KEY, resolve));
    return result[CONSENT_KEY] === true;
  } catch (error) {
    console.error('Error checking consent:', error);
    return false;
  }
}

function showConsentScreen() {
  document.getElementById('consent-screen').style.display = 'block';
  document.getElementById('main-ui').style.display = 'none';

  // set up consent button handler
  document.getElementById('acceptConsentBtn').addEventListener('click', async () => {
    await giveConsent();
    showMainUI();
    initializeMainUI();
  });
}

function showMainUI() {
  document.getElementById('consent-screen').style.display = 'none';
  document.getElementById('main-ui').style.display = 'block';
}

async function giveConsent() {
  try {
    if (isFirefox) {
      await browser.storage.local.set({
        [CONSENT_KEY]: true,
        [ENABLED_KEY]: true
      });
    } else {
      await new Promise(resolve => chrome.storage.local.set({
        [CONSENT_KEY]: true,
        [ENABLED_KEY]: true
      }, resolve));
    }
    console.log('[xflags] Consent given, extension enabled');
  } catch (error) {
    console.error('Error saving consent:', error);
  }
}

async function declineConsent() {
  try {
    if (isFirefox) {
      await browser.storage.local.set({
        [CONSENT_KEY]: false,
        [ENABLED_KEY]: false
      });
    } else {
      await new Promise(resolve => chrome.storage.local.set({
        [CONSENT_KEY]: false,
        [ENABLED_KEY]: false
      }, resolve));
    }
    console.log('[xflags] Consent declined, extension disabled');
  } catch (error) {
    console.error('Error saving consent decline:', error);
  }
}

function initializeMainUI() {
  const toggleSwitch = document.getElementById('toggleSwitch');
  const clearCacheBtn = document.getElementById('clearCacheBtn');
  const cacheTTLInput = document.getElementById('cacheTTL');
  const saveTTLBtn = document.getElementById('saveTTLBtn');
  const startTestBtn = document.getElementById('startTestBtn');
  const downloadLogBtn = document.getElementById('downloadLogBtn');
  const flagCount = document.getElementById('flagCount');
  const testStatus = document.getElementById('testStatus');

  // Error logging elements
  const errorLoggingSwitch = document.getElementById('errorLoggingSwitch');
  const downloadErrorLogBtn = document.getElementById('downloadErrorLogBtn');

  const tabButtons = document.querySelectorAll('.tab-button');
  const settingsTab = document.getElementById('settings-tab');
  const consoleTab = document.getElementById('console-tab');

  const consoleOutput = document.getElementById('consoleOutput');
  const consoleFetches = document.getElementById('consoleFetches');
  const consoleStatus = document.getElementById('consoleStatus');
  const clearConsoleBtn = document.getElementById('clearConsoleBtn');

  async function loadState() {
    try {
      const result = isFirefox ?
        await browser.storage.local.get([ENABLED_KEY, CACHE_TTL_KEY, ERROR_LOG_ENABLED_KEY]) :
        await new Promise(resolve => chrome.storage.local.get([ENABLED_KEY, CACHE_TTL_KEY, ERROR_LOG_ENABLED_KEY], resolve));

      const isEnabled = result[ENABLED_KEY] !== undefined ? result[ENABLED_KEY] : true;
      updateToggle(isEnabled);

      const ttl = result[CACHE_TTL_KEY] || DEFAULT_CACHE_TTL;
      const days = Math.round(ttl / (24 * 60 * 60 * 1000));
      cacheTTLInput.value = days;

      // Load error logging state
      const errorLoggingEnabled = result[ERROR_LOG_ENABLED_KEY] === true;
      updateErrorLoggingToggle(errorLoggingEnabled);
    } catch (error) {
      console.error('Error loading state:', error);
      updateToggle(true);
      cacheTTLInput.value = 30;
      updateErrorLoggingToggle(false);
    }
  }

  function updateToggle(isEnabled) {
    if (isEnabled) {
      toggleSwitch.classList.add('enabled');
    } else {
      toggleSwitch.classList.remove('enabled');
    }
  }

  function updateErrorLoggingToggle(isEnabled) {
    if (isEnabled) {
      errorLoggingSwitch.classList.add('enabled');
    } else {
      errorLoggingSwitch.classList.remove('enabled');
    }
  }

  toggleSwitch.addEventListener('click', async () => {
    try {
      const result = isFirefox ?
        await browser.storage.local.get(ENABLED_KEY) :
        await new Promise(resolve => chrome.storage.local.get(ENABLED_KEY, resolve));

      const currentState = result[ENABLED_KEY] !== undefined ? result[ENABLED_KEY] : true;
      const newState = !currentState;

      if (isFirefox) {
        await browser.storage.local.set({ [ENABLED_KEY]: newState });
      } else {
        await new Promise(resolve => chrome.storage.local.set({ [ENABLED_KEY]: newState }, resolve));
      }

      updateToggle(newState);

      const tabs = isFirefox ?
        await browser.tabs.query({ active: true, currentWindow: true }) :
        await new Promise(resolve => chrome.tabs.query({ active: true, currentWindow: true }, resolve));

      if (tabs[0]) {
        browserAPI.tabs.sendMessage(tabs[0].id, {
          type: 'extensionToggle',
          enabled: newState
        }).catch(() => {
          // tab might not have content script loaded
        });
      }
    } catch (error) {
      console.error('Error toggling extension:', error);
    }
  });

  clearCacheBtn.addEventListener('click', async () => {
    const confirmed = confirm('Are you sure you want to clear the cache? This will delete all stored flags and accounts, and the extension will start re-fetching location data.');

    if (!confirmed) {
      return;
    }

    try {
      if (isFirefox) {
        await browser.storage.local.remove('xflag_country_cache');
      } else {
        await new Promise(resolve => chrome.storage.local.remove('xflag_country_cache', resolve));
      }

      const tabs = isFirefox ?
        await browser.tabs.query({ active: true, currentWindow: true }) :
        await new Promise(resolve => chrome.tabs.query({ active: true, currentWindow: true }, resolve));

      if (tabs[0]) {
        browserAPI.tabs.sendMessage(tabs[0].id, { type: 'clearCache' }).catch(() => {});
      }
    } catch (error) {
      console.error('Error clearing cache:', error);
    }
  });

  saveTTLBtn.addEventListener('click', async () => {
    try {
      const days = parseInt(cacheTTLInput.value);
      if (isNaN(days) || days < 1 || days > 365) {
        alert('Invalid cache duration. Please enter a value between 1 and 365 days.');
        return;
      }

      const ttl = days * 24 * 60 * 60 * 1000;

      if (isFirefox) {
        await browser.storage.local.set({ [CACHE_TTL_KEY]: ttl });
      } else {
        await new Promise(resolve => chrome.storage.local.set({ [CACHE_TTL_KEY]: ttl }, resolve));
      }

      const tabs = isFirefox ?
        await browser.tabs.query({ active: true, currentWindow: true }) :
        await new Promise(resolve => chrome.tabs.query({ active: true, currentWindow: true }, resolve));

      if (tabs[0]) {
        browserAPI.tabs.sendMessage(tabs[0].id, {
          type: 'updateTTL',
          days: days
        }).catch(() => {});
      }
    } catch (error) {
      console.error('Error saving TTL:', error);
      alert('Error saving cache duration.');
    }
  });

  // Error logging toggle handler
  errorLoggingSwitch.addEventListener('click', async () => {
    try {
      const result = isFirefox ?
        await browser.storage.local.get(ERROR_LOG_ENABLED_KEY) :
        await new Promise(resolve => chrome.storage.local.get(ERROR_LOG_ENABLED_KEY, resolve));

      const currentState = result[ERROR_LOG_ENABLED_KEY] === true;
      const newState = !currentState;

      // Save to local storage
      if (isFirefox) {
        await browser.storage.local.set({ [ERROR_LOG_ENABLED_KEY]: newState });
      } else {
        await new Promise(resolve => chrome.storage.local.set({ [ERROR_LOG_ENABLED_KEY]: newState }, resolve));
      }

      // Notify service worker
      try {
        await browserAPI.runtime.sendMessage({
          type: SW_MESSAGE_TYPES.ERROR_LOG,
          enabled: newState
        });
      } catch (e) {
        // Service worker might not be available
        console.warn('Could not notify service worker of error logging change:', e);
      }

      updateErrorLoggingToggle(newState);
      console.log(`[xflags] Error logging ${newState ? 'enabled' : 'disabled'}`);
    } catch (error) {
      console.error('Error toggling error logging:', error);
    }
  });

  // Download error log handler
  downloadErrorLogBtn.addEventListener('click', async () => {
    try {
      // Request error export from service worker
      const response = await browserAPI.runtime.sendMessage({
        type: SW_MESSAGE_TYPES.ERROR_EXPORT
      });

      if (response && response.success && response.data) {
        const exportData = response.data;

        // Format as pretty JSON
        const jsonContent = JSON.stringify(exportData, null, 2);

        // Create download
        const blob = new Blob([jsonContent], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `xflags-error-log-${Date.now()}.json`;
        a.click();
        URL.revokeObjectURL(url);

        console.log(`[xflags] Downloaded error log with ${exportData.errorCount} errors`);
      } else {
        // No service worker response, try to get from local storage
        const result = isFirefox ?
          await browser.storage.local.get('xflag_error_log') :
          await new Promise(resolve => chrome.storage.local.get('xflag_error_log', resolve));

        const errors = result['xflag_error_log'] || [];

        const exportData = {
          exportedAt: new Date().toISOString(),
          extensionVersion: browserAPI.runtime.getManifest?.()?.version || 'unknown',
          browserInfo: {
            userAgent: 'redacted',
            platform: navigator.platform || 'unknown'
          },
          errorCount: errors.length,
          errors: errors
        };

        const jsonContent = JSON.stringify(exportData, null, 2);
        const blob = new Blob([jsonContent], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `xflags-error-log-${Date.now()}.json`;
        a.click();
        URL.revokeObjectURL(url);
      }
    } catch (error) {
      console.error('Error downloading error log:', error);
      alert('Error downloading error log. The log may be empty.');
    }
  });

  async function loadTestStats() {
    try {
      const tabs = isFirefox ?
        await browser.tabs.query({ active: true, currentWindow: true }) :
        await new Promise(resolve => chrome.tabs.query({ active: true, currentWindow: true }, resolve));

      if (tabs[0]) {
        browserAPI.tabs.sendMessage(tabs[0].id, { type: 'getTestStats' }, (response) => {
          if (response && response.stats) {
            flagCount.textContent = response.stats.flagCount || 0;

            if (response.stats.first429) {
              testStatus.textContent = '429 Error Hit!';
              testStatus.style.color = '#f91880';
            } else if (response.stats.testStartTime) {
              testStatus.textContent = 'Running...';
              testStatus.style.color = '#00ba7c';
            } else {
              testStatus.textContent = 'Not started';
              testStatus.style.color = '#536471';
            }
          }
        });
      }
    } catch (error) {
      console.error('Error loading test stats:', error);
    }
  }

  startTestBtn.addEventListener('click', async () => {
    try {
      const tabs = isFirefox ?
        await browser.tabs.query({ active: true, currentWindow: true }) :
        await new Promise(resolve => chrome.tabs.query({ active: true, currentWindow: true }, resolve));

      if (tabs[0]) {
        browserAPI.tabs.sendMessage(tabs[0].id, { type: 'startTest' }).catch(() => {});
        setTimeout(() => {
          loadTestStats();
        }, 1000);
      }
    } catch (error) {
      console.error('Error starting test:', error);
    }
  });

  downloadLogBtn.addEventListener('click', async () => {
    try {
      const tabs = isFirefox ?
        await browser.tabs.query({ active: true, currentWindow: true }) :
        await new Promise(resolve => chrome.tabs.query({ active: true, currentWindow: true }, resolve));

      if (tabs[0]) {
        browserAPI.tabs.sendMessage(tabs[0].id, { type: 'exportLog' }, (response) => {
          if (response && response.log) {
            const blob = new Blob([response.log], { type: 'text/plain' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `xflag-test-log-${Date.now()}.txt`;
            a.click();
            URL.revokeObjectURL(url);
          }
        });
      }
    } catch (error) {
      console.error('Error downloading log:', error);
    }
  });

  tabButtons.forEach(button => {
    button.addEventListener('click', () => {
      const targetTab = button.getAttribute('data-tab');

      tabButtons.forEach(btn => btn.classList.remove('active'));
      button.classList.add('active');

      if (targetTab === 'settings') {
        settingsTab.style.display = 'block';
        consoleTab.style.display = 'none';
      } else if (targetTab === 'console') {
        settingsTab.style.display = 'none';
        consoleTab.style.display = 'block';
        loadConsoleLogs();
      }
    });
  });

  async function loadConsoleLogs() {
    try {
      const tabs = isFirefox ?
        await browser.tabs.query({ active: true, currentWindow: true }) :
        await new Promise(resolve => chrome.tabs.query({ active: true, currentWindow: true }, resolve));

      if (tabs[0]) {
        browserAPI.tabs.sendMessage(tabs[0].id, { type: 'getConsoleLogs' }, (response) => {
          if (response && response.logs) {
            displayConsoleLogs(response.logs, response.stats);
          }
        });
      }
    } catch (error) {
      console.error('Error loading console logs:', error);
    }
  }

  function displayConsoleLogs(logs, stats) {
    consoleFetches.textContent = stats.fetches || 0;

    if (stats.rateLimited) {
      consoleStatus.textContent = 'Paused';
      consoleStatus.style.color = '#ffa500';
    } else if (stats.idle) {
      consoleStatus.textContent = 'Idle';
      consoleStatus.style.color = '#536471';
    } else {
      consoleStatus.textContent = 'Active';
      consoleStatus.style.color = '#00ba7c';
    }

    if (logs.length === 0) {
      consoleOutput.innerHTML = '<div class="console-placeholder">Waiting for activity...</div>';
      return;
    }

    // Clear existing content
    consoleOutput.innerHTML = '';

    // Create elements safely using DOM methods
    for (const log of logs) {
      const time = new Date(log.timestamp).toLocaleTimeString();
      const icon = getIconForType(log.type);

      const logDiv = document.createElement('div');
      logDiv.className = 'console-line';

      // Add the log.type as a class only if it's a known safe value
      const validTypes = ['fetch', 'error', 'status', 'info'];
      if (validTypes.includes(log.type)) {
        logDiv.classList.add(log.type);
      }

      // Use textContent for all dynamic content to prevent XSS
      logDiv.textContent = `[${time}] ${icon} ${log.message}`;

      consoleOutput.appendChild(logDiv);
    }

    consoleOutput.scrollTop = consoleOutput.scrollHeight;
  }

  function getIconForType(type) {
    switch (type) {
      case 'fetch': return '[OK]';
      case 'error': return '[X]';
      case 'status': return '[!]';
      case 'info': return '[i]';
      default: return '[-]';
    }
  }

  // NOTE: escapeHtml function was removed as it was unused.
  // The code now uses textContent directly which is safer and more efficient.

  clearConsoleBtn.addEventListener('click', async () => {
    try {
      const tabs = isFirefox ?
        await browser.tabs.query({ active: true, currentWindow: true }) :
        await new Promise(resolve => chrome.tabs.query({ active: true, currentWindow: true }, resolve));

      if (tabs[0]) {
        browserAPI.tabs.sendMessage(tabs[0].id, { type: 'clearConsoleLogs' }, () => {
          loadConsoleLogs();
        });
      }
    } catch (error) {
      console.error('Error clearing console:', error);
    }
  });

  loadState();
  loadTestStats();

  // refresh stats and console logs every 2 seconds while popup is open
  // Store reference for cleanup on unload
  refreshIntervalId = setInterval(() => {
    loadTestStats();

    // only refresh console if console tab is visible
    if (consoleTab.style.display !== 'none') {
      loadConsoleLogs();
    }
  }, REFRESH_INTERVAL);
}

// Clean up interval when popup is closed to prevent memory leaks
// This is important because the popup can be opened/closed many times
window.addEventListener('unload', () => {
  if (refreshIntervalId !== null) {
    clearInterval(refreshIntervalId);
    refreshIntervalId = null;
  }
});

// Also clean up on beforeunload for broader browser support
window.addEventListener('beforeunload', () => {
  if (refreshIntervalId !== null) {
    clearInterval(refreshIntervalId);
    refreshIntervalId = null;
  }
});
