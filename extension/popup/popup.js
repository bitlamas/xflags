const ENABLED_KEY = 'xflag_enabled';
const CACHE_TTL_KEY = 'xflag_cache_ttl';
const CONSENT_KEY = 'xflag_consent_given';
const DEFAULT_CACHE_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days

const isFirefox = typeof browser !== 'undefined';
const browserAPI = isFirefox ? browser : chrome;

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
        await browser.storage.local.get([ENABLED_KEY, CACHE_TTL_KEY]) :
        await new Promise(resolve => chrome.storage.local.get([ENABLED_KEY, CACHE_TTL_KEY], resolve));

      const isEnabled = result[ENABLED_KEY] !== undefined ? result[ENABLED_KEY] : true;
      updateToggle(isEnabled);

      const ttl = result[CACHE_TTL_KEY] || DEFAULT_CACHE_TTL;
      const days = Math.round(ttl / (24 * 60 * 60 * 1000));
      cacheTTLInput.value = days;
    } catch (error) {
      console.error('Error loading state:', error);
      updateToggle(true);
      cacheTTLInput.value = 30;
    }
  }

  function updateToggle(isEnabled) {
    if (isEnabled) {
      toggleSwitch.classList.add('enabled');
    } else {
      toggleSwitch.classList.remove('enabled');
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

    let html = '';
    for (const log of logs) {
      const time = new Date(log.timestamp).toLocaleTimeString();
      const icon = getIconForType(log.type);
      html += `<div class="console-line ${log.type}">[${time}] ${icon} ${escapeHtml(log.message)}</div>`;
    }

    consoleOutput.innerHTML = html;

    consoleOutput.scrollTop = consoleOutput.scrollHeight;
  }

  function getIconForType(type) {
    switch (type) {
      case 'fetch': return '✓';
      case 'error': return '✗';
      case 'status': return '⚠';
      case 'info': return 'ℹ';
      default: return '·';
    }
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

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
  setInterval(() => {
    loadTestStats();

    // only refresh console if console tab is visible
    if (consoleTab.style.display !== 'none') {
      loadConsoleLogs();
    }
  }, 2000);
}
