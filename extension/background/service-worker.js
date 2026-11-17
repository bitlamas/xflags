// service-worker.js - Background service worker for xflags extension
// Acts as central coordinator for all tabs with unified cache and request deduplication

// Chrome runs this file as a service worker (importScripts available);
// Firefox loads utils/rate-limit-policy.js via manifest background.scripts instead.
if (typeof importScripts === 'function' && typeof self.XflagRatePolicy === 'undefined') {
  importScripts('../utils/rate-limit-policy.js');
}

/**
 * Service Worker Message Types
 * Used for communication between content scripts and service worker
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
  RATE_LIMIT_ACQUIRE: 'SW_RATE_LIMIT_ACQUIRE',
  RATE_LIMIT_REPORT: 'SW_RATE_LIMIT_REPORT',

  // Error logging
  ERROR_LOG: 'SW_ERROR_LOG',
  ERROR_GET_ALL: 'SW_ERROR_GET_ALL',
  ERROR_CLEAR: 'SW_ERROR_CLEAR',
  ERROR_EXPORT: 'SW_ERROR_EXPORT'
};

/**
 * Storage keys for persistent data
 */
const STORAGE_KEYS = {
  CACHE: 'xflag_country_cache',
  CACHE_TTL: 'xflag_cache_ttl',
  ERROR_LOG_ENABLED: 'xflag_error_log_enabled',
  ERROR_LOG: 'xflag_error_log'
};

/**
 * Default configuration values
 */
const DEFAULTS = {
  CACHE_TTL: 30 * 24 * 60 * 60 * 1000, // 30 days in milliseconds
  MAX_ERRORS: 100,
  CACHE_SAVE_DEBOUNCE: 5000
};

/**
 * UnifiedCache - Central cache manager for all tabs
 * Replaces per-tab caching with a single source of truth
 */
class UnifiedCache {
  constructor() {
    /** @type {Map<string, {location: string, accurate: boolean, cachedAt: number}>} */
    this.memoryCache = new Map();

    /** @type {number} Cache TTL in milliseconds */
    this.ttl = DEFAULTS.CACHE_TTL;

    /** @type {boolean} Whether cache has been loaded from storage */
    this.loaded = false;

    /** @type {number|null} Debounce timer for save operations */
    this.saveTimeout = null;

    /** @type {boolean} Whether a save is pending */
    this.savePending = false;
  }

  /**
   * Load cache from persistent storage
   * Filters out expired entries automatically
   */
  async load() {
    if (this.loaded) return;

    try {
      const browserAPI = typeof browser !== 'undefined' ? browser : chrome;

      // Load TTL setting
      const ttlResult = await browserAPI.storage.local.get(STORAGE_KEYS.CACHE_TTL);
      if (ttlResult[STORAGE_KEYS.CACHE_TTL] && typeof ttlResult[STORAGE_KEYS.CACHE_TTL] === 'number') {
        this.ttl = ttlResult[STORAGE_KEYS.CACHE_TTL];
      }

      // Load cache data
      const cacheResult = await browserAPI.storage.local.get(STORAGE_KEYS.CACHE);
      const cached = cacheResult[STORAGE_KEYS.CACHE];

      if (cached && typeof cached === 'object') {
        const now = Date.now();

        for (const [username, data] of Object.entries(cached)) {
          // Only load non-expired entries with valid location
          if (data.expiry && data.expiry > now && data.location !== null) {
            this.memoryCache.set(username, {
              location: data.location,
              accurate: data.accurate !== false,
              cachedAt: data.cachedAt || now
            });
          }
        }

        console.log(`[xflags SW] Loaded ${this.memoryCache.size} cached entries`);
      }

      this.loaded = true;
    } catch (error) {
      console.error('[xflags SW] Error loading cache:', error);
      this.loaded = true;
    }
  }

  /**
   * Check if username exists in cache
   * @param {string} username - X username
   * @returns {boolean} True if cached and not expired
   */
  has(username) {
    if (!this.memoryCache.has(username)) {
      return false;
    }

    const data = this.memoryCache.get(username);
    const expiry = data.cachedAt + this.ttl;

    // Check if expired
    if (expiry <= Date.now()) {
      this.memoryCache.delete(username);
      return false;
    }

    return true;
  }

  /**
   * Get cached country data for username
   * @param {string} username - X username
   * @returns {{location: string, accurate: boolean}|null} Country data or null
   */
  get(username) {
    if (!this.has(username)) {
      return null;
    }

    const data = this.memoryCache.get(username);
    return {
      location: data.location,
      accurate: data.accurate
    };
  }

  /**
   * Set country data for username
   * @param {string} username - X username
   * @param {string} location - Country/region name
   * @param {boolean} accurate - Location accuracy flag
   */
  set(username, location, accurate = true) {
    this.memoryCache.set(username, {
      location: location,
      accurate: accurate,
      cachedAt: Date.now()
    });

    this.scheduleSave();
  }

  /**
   * Schedule a debounced save to persistent storage
   * @private
   */
  scheduleSave() {
    this.savePending = true;

    if (this.saveTimeout !== null) {
      clearTimeout(this.saveTimeout);
    }

    this.saveTimeout = setTimeout(() => {
      this.save();
      this.saveTimeout = null;
    }, DEFAULTS.CACHE_SAVE_DEBOUNCE);
  }

  /**
   * Save cache to persistent storage
   * @private
   */
  async save() {
    if (!this.savePending) return;

    try {
      const browserAPI = typeof browser !== 'undefined' ? browser : chrome;
      const cacheObj = {};
      const now = Date.now();

      for (const [username, data] of this.memoryCache.entries()) {
        const cachedAt = data.cachedAt || now;
        const expiry = cachedAt + this.ttl;

        // Only save non-expired entries
        if (expiry > now) {
          cacheObj[username] = {
            location: data.location,
            accurate: data.accurate,
            expiry: expiry,
            cachedAt: cachedAt
          };
        }
      }

      await browserAPI.storage.local.set({ [STORAGE_KEYS.CACHE]: cacheObj });
      this.savePending = false;
      console.log(`[xflags SW] Saved ${Object.keys(cacheObj).length} cache entries`);
    } catch (error) {
      console.error('[xflags SW] Error saving cache:', error);
    }
  }

  /**
   * Clear all cached data
   */
  async clear() {
    this.memoryCache.clear();
    this.savePending = false;

    if (this.saveTimeout !== null) {
      clearTimeout(this.saveTimeout);
      this.saveTimeout = null;
    }

    try {
      const browserAPI = typeof browser !== 'undefined' ? browser : chrome;
      await browserAPI.storage.local.remove(STORAGE_KEYS.CACHE);
      console.log('[xflags SW] Cache cleared');
    } catch (error) {
      console.error('[xflags SW] Error clearing cache:', error);
    }
  }

  /**
   * Get number of cached entries
   * @returns {number} Cache size
   */
  size() {
    return this.memoryCache.size;
  }

  /**
   * Set cache TTL
   * @param {number} days - TTL in days
   */
  async setTTL(days) {
    this.ttl = days * 24 * 60 * 60 * 1000;

    try {
      const browserAPI = typeof browser !== 'undefined' ? browser : chrome;
      await browserAPI.storage.local.set({ [STORAGE_KEYS.CACHE_TTL]: this.ttl });
      console.log(`[xflags SW] Cache TTL set to ${days} days`);
    } catch (error) {
      console.error('[xflags SW] Error saving TTL:', error);
    }
  }

  /**
   * Get current TTL in days
   * @returns {number} TTL in days
   */
  getTTLDays() {
    return this.ttl / (24 * 60 * 60 * 1000);
  }
}

/**
 * RequestDeduplicator - Prevents duplicate API requests across tabs
 *
 * One tab "claims" a username and fetches it; other tabs wait for its result.
 * Claims are released when:
 * - the owning tab reports completion (success OR failure)
 * - the owning tab's page goes away (its long-lived port disconnects)
 * - the claim is older than CLAIM_TIMEOUT (backstop for crashed tabs)
 * Waiters are released after WAIT_TIMEOUT with status 'timeout' so they can fetch themselves.
 */
class RequestDeduplicator {
  constructor() {
    /** @type {Map<string, {tabId: number, startedAt: number, waiters: Array<{resolve: Function, timer: number}>}>} */
    this.claims = new Map();

    /** Backstop for claims whose owner vanished without telling us (5 minutes) */
    this.CLAIM_TIMEOUT = 5 * 60 * 1000;

    /** How long a waiting tab waits before giving up and fetching itself */
    this.WAIT_TIMEOUT = 60 * 1000;
  }

  /**
   * Check if a fresh claim exists for this username
   * @param {string} username - X username
   * @returns {boolean}
   */
  isInFlight(username) {
    const claim = this.claims.get(username);
    if (!claim) return false;

    if (Date.now() - claim.startedAt > this.CLAIM_TIMEOUT) {
      this.completeRequest(username, null, 'timeout');
      return false;
    }

    return true;
  }

  /**
   * Claim a username for fetching
   * @param {string} username - X username
   * @param {number} tabId - Tab that will fetch
   */
  startRequest(username, tabId) {
    if (!this.claims.has(username)) {
      this.claims.set(username, { tabId, startedAt: Date.now(), waiters: [] });
    }
  }

  /**
   * Wait for another tab's claim to complete
   * @param {string} username - X username
   * @returns {Promise<{data: Object|null, status: string}>}
   */
  waitForRequest(username) {
    return new Promise((resolve) => {
      const claim = this.claims.get(username);
      if (!claim) {
        resolve({ data: null, status: 'timeout' });
        return;
      }

      const waiter = { resolve, timer: null };
      waiter.timer = setTimeout(() => {
        const current = this.claims.get(username);
        if (current) {
          current.waiters = current.waiters.filter(w => w !== waiter);
        }
        resolve({ data: null, status: 'timeout' });
      }, this.WAIT_TIMEOUT);

      claim.waiters.push(waiter);
    });
  }

  /**
   * Complete a claim and notify all waiting tabs
   * @param {string} username - X username
   * @param {Object|null} data - Location data or null
   * @param {string} status - 'ok' | 'nodata' | 'failed' | 'timeout'
   */
  completeRequest(username, data, status) {
    const claim = this.claims.get(username);
    this.claims.delete(username);
    if (!claim) return;

    if (claim.waiters.length > 0) {
      console.log(`[xflags SW] Completing @${username} (${status}), notifying ${claim.waiters.length} waiter(s)`);
    }

    for (const waiter of claim.waiters) {
      clearTimeout(waiter.timer);
      try {
        waiter.resolve({ data, status });
      } catch (error) {
        console.error('[xflags SW] Error notifying waiter:', error);
      }
    }
  }

  /**
   * Release every claim owned by a tab (page unloaded / navigated / closed)
   * @param {number} tabId
   */
  releaseTab(tabId) {
    for (const [username, claim] of [...this.claims]) {
      if (claim.tabId === tabId) {
        this.completeRequest(username, null, 'failed');
      }
    }
  }

  /**
   * Get number of in-flight requests
   * @returns {number} Number of pending requests
   */
  getPendingCount() {
    return this.claims.size;
  }
}

/**
 * RateLimitCoordinator - One request budget shared by all tabs
 *
 * Wraps XflagRatePolicy.RateBudget and persists it to storage.session so the
 * cooldown survives the service worker being suspended.
 */
class RateLimitCoordinator {
  constructor() {
    this.budget = new self.XflagRatePolicy.RateBudget();
    this.loaded = false;
    this.STORAGE_KEY = 'xflag_rate_budget';
  }

  #area() {
    const api = typeof browser !== 'undefined' ? browser : chrome;
    return api.storage.session || api.storage.local;
  }

  async load() {
    if (this.loaded) return;
    try {
      const result = await this.#area().get(this.STORAGE_KEY);
      this.budget.restore(result[this.STORAGE_KEY]);
    } catch (error) {
      console.warn('[xflags SW] Could not restore rate budget:', error);
    }
    this.loaded = true;
  }

  #persist() {
    this.#area().set({ [this.STORAGE_KEY]: this.budget.toJSON() }).catch(() => {});
  }

  /**
   * Reserve the next request slot (global across tabs)
   * @returns {{waitMs: number, cooldown: boolean}}
   */
  acquire() {
    const slot = this.budget.acquire();
    this.#persist();
    return slot;
  }

  /**
   * Record x-rate-limit-* headers reported by a tab
   * @param {Object} info - parsed headers (resetAt is an absolute local timestamp)
   */
  report(info) {
    this.budget.update(info);
    this.#persist();
  }

  /**
   * Enter cooldown until an absolute timestamp
   * @param {number} until - epoch ms
   */
  setCooldown(until) {
    this.budget.setCooldown(until);
    console.log('[xflags SW] Rate limited, cooldown until:', new Date(this.budget.cooldownUntil).toISOString());
    this.#persist();
  }

  /**
   * Check current rate limit status
   * @returns {{isRateLimited: boolean, expiresIn: number|null}} Rate limit status
   */
  getStatus() {
    const remaining = this.budget.cooldownRemaining();
    return {
      isRateLimited: remaining > 0,
      expiresIn: remaining > 0 ? remaining : null
    };
  }
}

/**
 * ErrorCollector - Collects errors for opt-in error reporting
 */
class ErrorCollector {
  constructor() {
    /** @type {Array<Object>} Rolling buffer of errors */
    this.errors = [];

    /** @type {number} Maximum number of errors to keep */
    this.maxErrors = DEFAULTS.MAX_ERRORS;

    /** @type {boolean} Whether error logging is enabled */
    this.enabled = false;

    /** @type {boolean} Whether settings have been loaded */
    this.loaded = false;
  }

  /**
   * Load error log settings and data from storage
   */
  async load() {
    if (this.loaded) return;

    try {
      const browserAPI = typeof browser !== 'undefined' ? browser : chrome;

      const result = await browserAPI.storage.local.get([
        STORAGE_KEYS.ERROR_LOG_ENABLED,
        STORAGE_KEYS.ERROR_LOG
      ]);

      this.enabled = result[STORAGE_KEYS.ERROR_LOG_ENABLED] === true;

      if (result[STORAGE_KEYS.ERROR_LOG] && Array.isArray(result[STORAGE_KEYS.ERROR_LOG])) {
        this.errors = result[STORAGE_KEYS.ERROR_LOG].slice(-this.maxErrors);
      }

      this.loaded = true;
      console.log(`[xflags SW] Error collector loaded, enabled: ${this.enabled}, errors: ${this.errors.length}`);
    } catch (error) {
      console.error('[xflags SW] Error loading error collector:', error);
      this.loaded = true;
    }
  }

  /**
   * Set whether error logging is enabled
   * @param {boolean} enabled - Whether to enable error logging
   */
  async setEnabled(enabled) {
    this.enabled = enabled;

    try {
      const browserAPI = typeof browser !== 'undefined' ? browser : chrome;
      await browserAPI.storage.local.set({ [STORAGE_KEYS.ERROR_LOG_ENABLED]: enabled });
      console.log(`[xflags SW] Error logging ${enabled ? 'enabled' : 'disabled'}`);
    } catch (error) {
      console.error('[xflags SW] Error saving error log setting:', error);
    }
  }

  /**
   * Check if error logging is enabled
   * @returns {boolean} Whether error logging is enabled
   */
  isEnabled() {
    return this.enabled;
  }

  /**
   * Log an error
   * @param {Object} errorData - Error data
   * @param {string} errorData.action - What action was being performed
   * @param {string} errorData.message - Error message
   * @param {string} [errorData.stack] - Stack trace (sanitized)
   * @param {Object} [errorData.context] - Additional context (sanitized)
   */
  async logError(errorData) {
    if (!this.enabled) return;

    const entry = {
      timestamp: Date.now(),
      action: errorData.action || 'unknown',
      message: this.sanitizeString(errorData.message || 'Unknown error'),
      stack: errorData.stack ? this.sanitizeStack(errorData.stack) : null,
      context: errorData.context ? this.sanitizeContext(errorData.context) : null
    };

    this.errors.push(entry);

    // Keep only the last maxErrors entries
    if (this.errors.length > this.maxErrors) {
      this.errors = this.errors.slice(-this.maxErrors);
    }

    await this.save();
  }

  /**
   * Sanitize a string to remove potential sensitive data
   * @param {string} str - String to sanitize
   * @returns {string} Sanitized string
   * @private
   */
  sanitizeString(str) {
    if (typeof str !== 'string') return String(str);

    // Remove potential auth tokens (Bearer tokens, etc.)
    let sanitized = str.replace(/Bearer\s+[A-Za-z0-9\-._~+\/]+=*/gi, 'Bearer [REDACTED]');

    // Remove potential CSRF tokens
    sanitized = sanitized.replace(/csrf[_-]?token["\s:=]+[A-Za-z0-9\-._~+\/]+=*/gi, 'csrf_token=[REDACTED]');

    // Remove potential session IDs
    sanitized = sanitized.replace(/session[_-]?id["\s:=]+[A-Za-z0-9\-._~+\/]+=*/gi, 'session_id=[REDACTED]');

    return sanitized;
  }

  /**
   * Sanitize a stack trace
   * @param {string} stack - Stack trace
   * @returns {string} Sanitized stack trace
   * @private
   */
  sanitizeStack(stack) {
    if (typeof stack !== 'string') return null;

    // Keep only the structure, remove file paths that might contain usernames
    return stack
      .split('\n')
      .map(line => {
        // Keep function names and line numbers, but sanitize paths
        return line.replace(/([A-Z]:\\Users\\[^\\]+)/gi, '[USER_PATH]')
                   .replace(/(\/Users\/[^\/]+)/gi, '[USER_PATH]')
                   .replace(/(\/home\/[^\/]+)/gi, '[USER_PATH]');
      })
      .slice(0, 10) // Limit stack depth
      .join('\n');
  }

  /**
   * Sanitize context object
   * @param {Object} context - Context object
   * @returns {Object} Sanitized context
   * @private
   */
  sanitizeContext(context) {
    if (typeof context !== 'object' || context === null) return null;

    const sanitized = {};
    const allowedKeys = ['url', 'status', 'statusText', 'type', 'username', 'action'];

    for (const key of allowedKeys) {
      if (key in context) {
        let value = context[key];

        // Sanitize URL to remove query params that might contain tokens
        if (key === 'url' && typeof value === 'string') {
          try {
            const url = new URL(value);
            // Keep only the pathname
            value = url.origin + url.pathname;
          } catch (e) {
            value = '[INVALID_URL]';
          }
        }

        sanitized[key] = typeof value === 'string' ? this.sanitizeString(value) : value;
      }
    }

    return sanitized;
  }

  /**
   * Save errors to persistent storage
   * @private
   */
  async save() {
    try {
      const browserAPI = typeof browser !== 'undefined' ? browser : chrome;
      await browserAPI.storage.local.set({ [STORAGE_KEYS.ERROR_LOG]: this.errors });
    } catch (error) {
      console.error('[xflags SW] Error saving error log:', error);
    }
  }

  /**
   * Get all logged errors
   * @returns {Array<Object>} Array of error entries
   */
  getAll() {
    return [...this.errors];
  }

  /**
   * Clear all logged errors
   */
  async clear() {
    this.errors = [];
    await this.save();
    console.log('[xflags SW] Error log cleared');
  }

  /**
   * Export errors as JSON for download
   * @returns {Object} Export data
   */
  export() {
    const browserAPI = typeof browser !== 'undefined' ? browser : chrome;

    return {
      exportedAt: new Date().toISOString(),
      extensionVersion: browserAPI.runtime.getManifest?.()?.version || 'unknown',
      browserInfo: {
        userAgent: 'redacted', // Don't include full user agent
        platform: typeof navigator !== 'undefined' ? navigator.platform : 'unknown'
      },
      errorCount: this.errors.length,
      errors: this.errors
    };
  }
}

// Initialize global instances
const unifiedCache = new UnifiedCache();
const requestDeduplicator = new RequestDeduplicator();
const rateLimitCoordinator = new RateLimitCoordinator();
const errorCollector = new ErrorCollector();

/**
 * Handle messages from content scripts
 */
function handleMessage(message, sender, sendResponse) {
  const tabId = sender.tab?.id || -1;

  // Async handler wrapper
  const handleAsync = async () => {
    try {
      switch (message.type) {
        // Cache operations
        case SW_MESSAGE_TYPES.CACHE_LOAD:
          await unifiedCache.load();
          return { success: true };

        case SW_MESSAGE_TYPES.CACHE_GET:
          await unifiedCache.load();
          const data = unifiedCache.get(message.username);
          return { success: true, data };

        case SW_MESSAGE_TYPES.CACHE_SET:
          await unifiedCache.load();
          unifiedCache.set(message.username, message.location, message.accurate);
          return { success: true };

        case SW_MESSAGE_TYPES.CACHE_HAS:
          await unifiedCache.load();
          const exists = unifiedCache.has(message.username);
          return { success: true, exists };

        case SW_MESSAGE_TYPES.CACHE_CLEAR:
          await unifiedCache.clear();
          return { success: true };

        case SW_MESSAGE_TYPES.CACHE_SIZE:
          await unifiedCache.load();
          return { success: true, size: unifiedCache.size() };

        case SW_MESSAGE_TYPES.CACHE_SET_TTL:
          await unifiedCache.setTTL(message.days);
          return { success: true };

        case SW_MESSAGE_TYPES.CACHE_GET_TTL:
          await unifiedCache.load();
          return { success: true, days: unifiedCache.getTTLDays() };

        // Request deduplication
        case SW_MESSAGE_TYPES.REQUEST_LOCATION:
          await unifiedCache.load();

          // First check cache
          if (unifiedCache.has(message.username)) {
            const cached = unifiedCache.get(message.username);
            return { success: true, cached: true, data: cached };
          }

          // Another tab is fetching it: wait for that result (bounded by WAIT_TIMEOUT)
          if (requestDeduplicator.isInFlight(message.username)) {
            const { data: waitedData, status } = await requestDeduplicator.waitForRequest(message.username);
            return { success: true, cached: false, waited: true, status, data: waitedData };
          }

          // New request - caller should make the API call
          requestDeduplicator.startRequest(message.username, tabId);
          return { success: true, cached: false, waited: false, shouldFetch: true };

        case SW_MESSAGE_TYPES.REQUEST_COMPLETE:
          // Complete request and notify all waiters
          if (message.data && message.data.location) {
            unifiedCache.set(message.username, message.data.location, message.data.accurate);
          }
          requestDeduplicator.completeRequest(
            message.username,
            message.data || null,
            message.status || (message.data ? 'ok' : 'failed')
          );
          return { success: true };

        // Rate limiting (one budget for all tabs)
        case SW_MESSAGE_TYPES.RATE_LIMIT_STATUS:
          await rateLimitCoordinator.load();
          return { success: true, ...rateLimitCoordinator.getStatus() };

        case SW_MESSAGE_TYPES.RATE_LIMIT_ACQUIRE:
          await rateLimitCoordinator.load();
          return { success: true, ...rateLimitCoordinator.acquire() };

        case SW_MESSAGE_TYPES.RATE_LIMIT_REPORT:
          await rateLimitCoordinator.load();
          rateLimitCoordinator.report(message.info);
          return { success: true };

        case SW_MESSAGE_TYPES.RATE_LIMIT_SET:
          await rateLimitCoordinator.load();
          if (message.isRateLimited && typeof message.until === 'number') {
            rateLimitCoordinator.setCooldown(message.until);
          }
          return { success: true, ...rateLimitCoordinator.getStatus() };

        // Error logging
        case SW_MESSAGE_TYPES.ERROR_LOG:
          await errorCollector.load();
          if (message.enabled !== undefined) {
            await errorCollector.setEnabled(message.enabled);
          } else if (message.error) {
            await errorCollector.logError(message.error);
          }
          return { success: true, enabled: errorCollector.isEnabled() };

        case SW_MESSAGE_TYPES.ERROR_GET_ALL:
          await errorCollector.load();
          return { success: true, errors: errorCollector.getAll(), enabled: errorCollector.isEnabled() };

        case SW_MESSAGE_TYPES.ERROR_CLEAR:
          await errorCollector.clear();
          return { success: true };

        case SW_MESSAGE_TYPES.ERROR_EXPORT:
          await errorCollector.load();
          return { success: true, data: errorCollector.export() };

        default:
          console.warn('[xflags SW] Unknown message type:', message.type);
          return { success: false, error: 'Unknown message type' };
      }
    } catch (error) {
      console.error('[xflags SW] Error handling message:', error);
      return { success: false, error: error.message };
    }
  };

  // Handle async response
  handleAsync().then(sendResponse);
  return true; // Keep channel open for async response
}

// Register message listener
const browserAPI = typeof browser !== 'undefined' ? browser : chrome;
browserAPI.runtime.onMessage.addListener(handleMessage);

// Each content script keeps a port open; when the page unloads the port
// disconnects and we release that tab's claims so other tabs don't wait on them.
browserAPI.runtime.onConnect.addListener((port) => {
  if (port.name !== 'xflag-tab') return;
  const tabId = port.sender?.tab?.id;
  port.onDisconnect.addListener(() => {
    if (typeof tabId === 'number') {
      requestDeduplicator.releaseTab(tabId);
    }
  });
});

// Initialize on service worker start
(async function init() {
  console.log('[xflags SW] Service worker starting...');

  await unifiedCache.load();
  await errorCollector.load();
  await rateLimitCoordinator.load();

  console.log('[xflags SW] Service worker initialized');
})();

// Export message types for use in content scripts
// This will be available via the runtime API
if (typeof self !== 'undefined') {
  self.SW_MESSAGE_TYPES = SW_MESSAGE_TYPES;
}
