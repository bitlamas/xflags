// cache management - thin client that queries service worker
// Falls back to local storage if service worker is unavailable

const CACHE_KEY = 'xflag_country_cache';
const CACHE_TTL_KEY = 'xflag_cache_ttl';
const DEFAULT_CACHE_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days (configurable)

/**
 * Service Worker Message Types
 * Must match the types defined in service-worker.js
 */
const SW_MESSAGE_TYPES = {
  CACHE_GET: 'SW_CACHE_GET',
  CACHE_SET: 'SW_CACHE_SET',
  CACHE_HAS: 'SW_CACHE_HAS',
  CACHE_CLEAR: 'SW_CACHE_CLEAR',
  CACHE_SIZE: 'SW_CACHE_SIZE',
  CACHE_SET_TTL: 'SW_CACHE_SET_TTL',
  CACHE_GET_TTL: 'SW_CACHE_GET_TTL',
  CACHE_LOAD: 'SW_CACHE_LOAD',
  REQUEST_LOCATION: 'SW_REQUEST_LOCATION',
  REQUEST_COMPLETE: 'SW_REQUEST_COMPLETE',
  RATE_LIMIT_STATUS: 'SW_RATE_LIMIT_STATUS',
  RATE_LIMIT_SET: 'SW_RATE_LIMIT_SET',
  ERROR_LOG: 'SW_ERROR_LOG',
  ERROR_GET_ALL: 'SW_ERROR_GET_ALL',
  ERROR_CLEAR: 'SW_ERROR_CLEAR',
  ERROR_EXPORT: 'SW_ERROR_EXPORT'
};

/**
 * CountryCache - Thin client that delegates to service worker
 *
 * Features:
 * - Communicates with service worker for unified cache across tabs
 * - Falls back to local storage if service worker unavailable
 * - Memory cache for fast synchronous lookups
 * - Automatic sync with service worker on set operations
 *
 * @class
 */
class CountryCache {
  constructor() {
    /** @type {Map<string, {location: string, accurate: boolean, cachedAt: number}>} */
    this.memoryCache = new Map();

    /** @type {boolean} Whether cache has been loaded */
    this.loaded = false;

    /** @type {number} Cache TTL in milliseconds */
    this.ttl = DEFAULT_CACHE_TTL;

    /** @type {boolean} Whether service worker is available */
    this.serviceWorkerAvailable = false;

    /** @type {number|null} Debounce timer for save operations */
    this.saveTimeout = null;
  }

  /**
   * Send message to service worker
   * @param {Object} message - Message to send
   * @returns {Promise<Object>} Response from service worker
   * @private
   */
  async sendToServiceWorker(message) {
    try {
      const response = await window.xflagBrowser.runtime.sendMessage(message);
      return response;
    } catch (error) {
      // Service worker not available, mark as unavailable
      this.serviceWorkerAvailable = false;
      throw error;
    }
  }

  /**
   * Check if service worker is available
   * @returns {Promise<boolean>} True if service worker is available
   * @private
   */
  async checkServiceWorker() {
    try {
      const response = await this.sendToServiceWorker({ type: SW_MESSAGE_TYPES.CACHE_SIZE });
      this.serviceWorkerAvailable = response && response.success;
      return this.serviceWorkerAvailable;
    } catch (error) {
      this.serviceWorkerAvailable = false;
      return false;
    }
  }

  /**
   * Load cached data from service worker or browser storage into memory
   * Filters out expired entries automatically
   */
  async load() {
    if (this.loaded) return;

    try {
      // Try to use service worker first
      const swAvailable = await this.checkServiceWorker();

      if (swAvailable) {
        // Load from service worker
        const response = await this.sendToServiceWorker({ type: SW_MESSAGE_TYPES.CACHE_LOAD });

        if (response && response.success) {
          // Get TTL from service worker
          const ttlResponse = await this.sendToServiceWorker({ type: SW_MESSAGE_TYPES.CACHE_GET_TTL });
          if (ttlResponse && ttlResponse.success && ttlResponse.days) {
            this.ttl = ttlResponse.days * 24 * 60 * 60 * 1000;
          }

          console.log('[xflags] Cache loaded via service worker');
          this.loaded = true;
          return;
        }
      }

      // Fallback to local storage
      console.log('[xflags] Service worker unavailable, using local storage fallback');
      await this.loadFromLocalStorage();

    } catch (error) {
      console.error('[xflags] Error loading cache:', error);
      // Try local storage as final fallback
      await this.loadFromLocalStorage();
    }

    this.loaded = true;
  }

  /**
   * Load cache from local storage (fallback mode)
   * @private
   */
  async loadFromLocalStorage() {
    try {
      const ttlValue = await window.xflagBrowser.storage.get(CACHE_TTL_KEY);
      if (ttlValue && typeof ttlValue === 'number') {
        this.ttl = ttlValue;
      }

      const cached = await window.xflagBrowser.storage.get(CACHE_KEY);
      if (cached) {
        const now = Date.now();
        // Load unexpired entries into memory
        for (const [username, data] of Object.entries(cached)) {
          if (data.expiry && data.expiry > now && data.location !== null) {
            this.memoryCache.set(username, {
              location: data.location,
              accurate: data.accurate !== false,
              cachedAt: data.cachedAt || now
            });
          }
        }
      }
      console.log(`[xflags] Local cache loaded: ${this.memoryCache.size} entries`);
    } catch (error) {
      console.error('[xflags] Error loading from local storage:', error);
    }
  }

  /**
   * Check if username exists in cache
   * Uses memory cache for fast synchronous lookup
   * @param {string} username - X username
   * @returns {boolean} True if cached
   */
  has(username) {
    // If service worker is available and we haven't loaded locally, do async check
    // But for synchronous compatibility, use memory cache
    if (this.memoryCache.has(username)) {
      const data = this.memoryCache.get(username);
      const expiry = data.cachedAt + this.ttl;
      if (expiry > Date.now()) {
        return true;
      }
      // Expired, remove from memory
      this.memoryCache.delete(username);
    }
    return false;
  }

  /**
   * Check if username exists in cache (async version that queries service worker)
   * @param {string} username - X username
   * @returns {Promise<boolean>} True if cached
   */
  async hasAsync(username) {
    // Check memory cache first
    if (this.has(username)) {
      return true;
    }

    // If service worker available, query it
    if (this.serviceWorkerAvailable) {
      try {
        const response = await this.sendToServiceWorker({
          type: SW_MESSAGE_TYPES.CACHE_HAS,
          username
        });
        if (response && response.success && response.exists) {
          // Also fetch and cache locally for future sync lookups
          const dataResponse = await this.sendToServiceWorker({
            type: SW_MESSAGE_TYPES.CACHE_GET,
            username
          });
          if (dataResponse && dataResponse.success && dataResponse.data) {
            this.memoryCache.set(username, {
              location: dataResponse.data.location,
              accurate: dataResponse.data.accurate,
              cachedAt: Date.now()
            });
          }
          return true;
        }
      } catch (error) {
        // Fall through to return false
      }
    }

    return false;
  }

  /**
   * Get cached country data for username
   * @param {string} username - X username
   * @returns {Object|undefined} Country data {location: string, accurate: boolean} or undefined
   */
  get(username) {
    const data = this.memoryCache.get(username);
    if (!data) return undefined;

    // Check expiry
    const expiry = data.cachedAt + this.ttl;
    if (expiry <= Date.now()) {
      this.memoryCache.delete(username);
      return undefined;
    }

    return {
      location: data.location,
      accurate: data.accurate
    };
  }

  /**
   * Get cached country data for username (async version)
   * @param {string} username - X username
   * @returns {Promise<Object|null>} Country data or null
   */
  async getAsync(username) {
    // Check memory cache first
    const localData = this.get(username);
    if (localData) {
      return localData;
    }

    // Query service worker
    if (this.serviceWorkerAvailable) {
      try {
        const response = await this.sendToServiceWorker({
          type: SW_MESSAGE_TYPES.CACHE_GET,
          username
        });
        if (response && response.success && response.data) {
          // Cache locally
          this.memoryCache.set(username, {
            location: response.data.location,
            accurate: response.data.accurate,
            cachedAt: Date.now()
          });
          return response.data;
        }
      } catch (error) {
        // Fall through to return null
      }
    }

    return null;
  }

  /**
   * Set country data for username
   * Updates both local memory cache and service worker
   * @param {string} username - X username
   * @param {string} locationData - Country/region name
   * @param {boolean} accurate - Location accuracy flag (false for VPN)
   */
  set(username, locationData, accurate = true) {
    // Update local memory cache immediately
    this.memoryCache.set(username, {
      location: locationData,
      accurate: accurate,
      cachedAt: Date.now()
    });

    // Update service worker asynchronously
    if (this.serviceWorkerAvailable) {
      this.sendToServiceWorker({
        type: SW_MESSAGE_TYPES.CACHE_SET,
        username,
        location: locationData,
        accurate
      }).catch(error => {
        console.warn('[xflags] Failed to update service worker cache:', error);
        // Still save locally
        this.scheduleSave();
      });
    } else {
      // No service worker, save to local storage
      this.scheduleSave();
    }
  }

  /**
   * Schedule a debounced save to local storage (fallback mode)
   * @private
   */
  scheduleSave() {
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
    }

    this.saveTimeout = setTimeout(() => {
      this.save();
    }, 5000);
  }

  /**
   * Save memory cache to persistent storage (fallback mode)
   * @private
   */
  async save() {
    try {
      const cacheObj = {};
      const now = Date.now();

      for (const [username, data] of this.memoryCache.entries()) {
        const cachedAt = data.cachedAt || now;
        const expiry = cachedAt + this.ttl;

        if (expiry > now) {
          cacheObj[username] = {
            location: data.location,
            accurate: data.accurate,
            expiry: expiry,
            cachedAt: cachedAt
          };
        }
      }

      await window.xflagBrowser.storage.set(CACHE_KEY, cacheObj);
    } catch (error) {
      console.error('[xflags] Error saving cache:', error);
    }
  }

  /**
   * Set cache TTL (Time To Live)
   * @param {number} days - Cache duration in days (1-365)
   */
  async setTTL(days) {
    this.ttl = days * 24 * 60 * 60 * 1000;

    // Update service worker
    if (this.serviceWorkerAvailable) {
      try {
        await this.sendToServiceWorker({
          type: SW_MESSAGE_TYPES.CACHE_SET_TTL,
          days
        });
      } catch (error) {
        console.warn('[xflags] Failed to update service worker TTL:', error);
      }
    }

    // Also save locally as fallback
    await window.xflagBrowser.storage.set(CACHE_TTL_KEY, this.ttl);
    console.log(`[xflags] Cache TTL updated to ${days} days`);
  }

  /**
   * Get current TTL in days
   * @returns {number} TTL in days
   */
  getTTLDays() {
    return this.ttl / (24 * 60 * 60 * 1000);
  }

  /**
   * Clear all cached data
   * Removes from both memory, service worker, and persistent storage
   */
  async clear() {
    this.memoryCache.clear();

    // Clear service worker cache
    if (this.serviceWorkerAvailable) {
      try {
        await this.sendToServiceWorker({ type: SW_MESSAGE_TYPES.CACHE_CLEAR });
      } catch (error) {
        console.warn('[xflags] Failed to clear service worker cache:', error);
      }
    }

    // Also clear local storage
    try {
      await window.xflagBrowser.storage.remove(CACHE_KEY);
      console.log('[xflags] Cache cleared');
    } catch (error) {
      console.error('[xflags] Error clearing cache:', error);
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
   * Request location data with deduplication across tabs
   * Returns cached data immediately if available, or waits for in-flight request
   * @param {string} username - X username
   * @returns {Promise<{cached: boolean, shouldFetch: boolean, data: Object|null}>} Request result
   */
  async requestLocation(username) {
    if (!this.serviceWorkerAvailable) {
      // Fallback: just check local cache
      const localData = this.get(username);
      return {
        cached: !!localData,
        shouldFetch: !localData,
        data: localData
      };
    }

    try {
      const response = await this.sendToServiceWorker({
        type: SW_MESSAGE_TYPES.REQUEST_LOCATION,
        username
      });

      if (response && response.success) {
        // If we got data (cached or waited), update local memory cache
        if (response.data) {
          this.memoryCache.set(username, {
            location: response.data.location,
            accurate: response.data.accurate,
            cachedAt: Date.now()
          });
        }

        return {
          cached: response.cached || false,
          waited: response.waited || false,
          shouldFetch: response.shouldFetch || false,
          data: response.data || null
        };
      }
    } catch (error) {
      console.warn('[xflags] Error requesting location via service worker:', error);
    }

    // Fallback to local cache
    const localData = this.get(username);
    return {
      cached: !!localData,
      shouldFetch: !localData,
      data: localData
    };
  }

  /**
   * Complete a location request (notify service worker that fetch is done)
   * @param {string} username - X username
   * @param {Object|null} data - Location data or null if failed
   */
  async completeRequest(username, data) {
    if (!this.serviceWorkerAvailable) return;

    try {
      await this.sendToServiceWorker({
        type: SW_MESSAGE_TYPES.REQUEST_COMPLETE,
        username,
        data
      });
    } catch (error) {
      console.warn('[xflags] Error completing request via service worker:', error);
    }
  }

  /**
   * Get rate limit status from service worker
   * @returns {Promise<{isRateLimited: boolean, expiresIn: number|null}>}
   */
  async getRateLimitStatus() {
    if (!this.serviceWorkerAvailable) {
      return { isRateLimited: false, expiresIn: null };
    }

    try {
      const response = await this.sendToServiceWorker({
        type: SW_MESSAGE_TYPES.RATE_LIMIT_STATUS
      });
      if (response && response.success) {
        return {
          isRateLimited: response.isRateLimited || false,
          expiresIn: response.expiresIn || null
        };
      }
    } catch (error) {
      // Ignore errors
    }

    return { isRateLimited: false, expiresIn: null };
  }

  /**
   * Set rate limit status in service worker
   * @param {boolean} isRateLimited - Whether rate limited
   */
  async setRateLimitStatus(isRateLimited) {
    if (!this.serviceWorkerAvailable) return;

    try {
      await this.sendToServiceWorker({
        type: SW_MESSAGE_TYPES.RATE_LIMIT_SET,
        isRateLimited
      });
    } catch (error) {
      // Ignore errors
    }
  }

  /**
   * Check if service worker is being used
   * @returns {boolean} True if service worker is available
   */
  isUsingServiceWorker() {
    return this.serviceWorkerAvailable;
  }
}

if (typeof window !== 'undefined') {
  window.xflagCache = new CountryCache();

  // Export message types for use by other modules
  window.SW_MESSAGE_TYPES = SW_MESSAGE_TYPES;
}
