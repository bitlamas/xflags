// constants for message types and configuration values
// centralizes magic strings to reduce typo errors and improve maintainability

/**
 * Message types for cross-context communication
 * Used by interceptor.js (page context) and main.js (extension context)
 */
const MESSAGE_TYPES = {
  // Interceptor -> Main: country data captured from API response
  COUNTRY_DATA: 'XFLAG_COUNTRY_DATA',

  // Interceptor -> Main: auth headers captured from API request
  HEADERS_CAPTURED: 'XFLAG_HEADERS_CAPTURED',

  // ActiveFetcher -> Main: fetch response with location data
  FETCH_RESPONSE: 'XFLAG_FETCH_RESPONSE'
};

/**
 * Message types for popup -> content script communication
 */
const POPUP_MESSAGE_TYPES = {
  EXTENSION_TOGGLE: 'extensionToggle',
  CLEAR_CACHE: 'clearCache',
  UPDATE_TTL: 'updateTTL',
  START_TEST: 'startTest',
  GET_TEST_STATS: 'getTestStats',
  EXPORT_LOG: 'exportLog',
  GET_CONSOLE_LOGS: 'getConsoleLogs',
  CLEAR_CONSOLE_LOGS: 'clearConsoleLogs'
};

/**
 * Storage keys for browser.storage.local
 */
const STORAGE_KEYS = {
  ENABLED: 'xflag_enabled',
  CACHE: 'xflag_country_cache',
  CACHE_TTL: 'xflag_cache_ttl',
  CONSENT: 'xflag_consent_given'
};

/**
 * Timing constants (milliseconds)
 */
const TIMING = {
  MIN_REQUEST_INTERVAL: 5000,      // 5 seconds between API requests
  RATE_LIMIT_COOLDOWN: 300000,     // 5 minutes cooldown after 429
  DEFAULT_CACHE_TTL: 30 * 24 * 60 * 60 * 1000, // 30 days
  OBSERVER_DEBOUNCE: 300,          // Debounce for MutationObserver
  CACHE_SAVE_DEBOUNCE: 5000,       // Debounce for cache saves
  POPUP_REFRESH_INTERVAL: 2000     // Popup stats refresh interval
};

/**
 * Fetcher states
 */
const FETCHER_STATES = {
  ACTIVE: 'active',
  IDLE: 'idle',
  RATE_LIMITED: 'rate-limited'
};

/**
 * Log types for console logger
 */
const LOG_TYPES = {
  FETCH: 'fetch',
  ERROR: 'error',
  STATUS: 'status',
  INFO: 'info'
};

/**
 * Service Worker Message Types
 * Used for communication between content scripts/popup and service worker
 */
const SW_MESSAGE_TYPES = {
  // Cache operations
  CACHE_GET: 'SW_CACHE_GET',
  CACHE_SET: 'SW_CACHE_SET',
  CACHE_HAS: 'SW_CACHE_HAS',
  CACHE_CLEAR: 'SW_CACHE_CLEAR',
  CACHE_SIZE: 'SW_CACHE_SIZE',
  CACHE_SET_TTL: 'SW_CACHE_SET_TTL',
  CACHE_GET_TTL: 'SW_CACHE_GET_TTL',
  CACHE_LOAD: 'SW_CACHE_LOAD',

  // Request deduplication
  REQUEST_LOCATION: 'SW_REQUEST_LOCATION',
  REQUEST_COMPLETE: 'SW_REQUEST_COMPLETE',

  // Rate limiting coordination
  RATE_LIMIT_STATUS: 'SW_RATE_LIMIT_STATUS',
  RATE_LIMIT_SET: 'SW_RATE_LIMIT_SET',

  // Error logging
  ERROR_LOG: 'SW_ERROR_LOG',
  ERROR_GET_ALL: 'SW_ERROR_GET_ALL',
  ERROR_CLEAR: 'SW_ERROR_CLEAR',
  ERROR_EXPORT: 'SW_ERROR_EXPORT'
};

/**
 * Generate a unique message token for validation
 * Used to prevent malicious page scripts from spoofing messages
 * @returns {string} Random token
 */
function generateMessageToken() {
  return Math.random().toString(36).substring(2, 15) +
         Math.random().toString(36).substring(2, 15);
}

// Export for use in different contexts
if (typeof window !== 'undefined') {
  window.XFLAG_CONSTANTS = {
    MESSAGE_TYPES,
    POPUP_MESSAGE_TYPES,
    STORAGE_KEYS,
    TIMING,
    FETCHER_STATES,
    LOG_TYPES,
    SW_MESSAGE_TYPES,
    generateMessageToken
  };
}
