// cache management using browser.storage.local

const CACHE_KEY = 'xflag_country_cache';
const CACHE_TTL_KEY = 'xflag_cache_ttl';
const DEFAULT_CACHE_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days (configurable)

/**
 * CountryCache - Local storage manager for country/location data
 *
 * Features:
 * - Configurable TTL (1-365 days, default 30 days)
 * - Memory cache (Map) + persistent storage (browser.storage.local)
 * - Automatic expiration of old entries
 * - Scheduled batch saves (5-second debounce)
 *
 * @class
 */
class CountryCache {
  constructor() {
    this.memoryCache = new Map();
    this.loaded = false;
    this.ttl = DEFAULT_CACHE_TTL;
  }

  /**
   * Load cached data from browser storage into memory
   * Filters out expired entries automatically
   */
  async load() {
    if (this.loaded) return;

    try {
      const ttlValue = await window.xflagBrowser.storage.get(CACHE_TTL_KEY);
      if (ttlValue && typeof ttlValue === 'number') {
        this.ttl = ttlValue;
      }

      const cached = await window.xflagBrowser.storage.get(CACHE_KEY);
      if (cached) {
        const now = Date.now();
        // load unexpired entries into memory
        for (const [username, data] of Object.entries(cached)) {
          if (data.expiry && data.expiry > now && data.location !== null) {
            this.memoryCache.set(username, {
              location: data.location,
              accurate: data.accurate !== false
            });
          }
        }
      }
      this.loaded = true;
    } catch (error) {
      console.error('[xflags] Error loading cache:', error);
      this.loaded = true;
    }
  }

  /**
   * Check if username exists in cache
   * @param {string} username - X username
   * @returns {boolean} True if cached
   */
  has(username) {
    return this.memoryCache.has(username);
  }

  /**
   * Get cached country data for username
   * @param {string} username - X username
   * @returns {Object|undefined} Country data {location: string, accurate: boolean} or undefined
   */
  get(username) {
    return this.memoryCache.get(username);
  }

  /**
   * Set country data for username
   * Schedules automatic save to persistent storage
   * @param {string} username - X username
   * @param {string} locationData - Country/region name
   * @param {boolean} accurate - Location accuracy flag (false for VPN)
   */
  set(username, locationData, accurate = true) {
    this.memoryCache.set(username, {
      location: locationData,
      accurate: accurate
    });

    this.scheduleSave();
  }

  scheduleSave() {
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
    }

    this.saveTimeout = setTimeout(() => {
      this.save();
    }, 5000); // save after 5 seconds of inactivity
  }

  /**
   * Save memory cache to persistent storage
   * Sets expiry timestamp for all entries based on current TTL
   * @private
   */
  async save() {
    try {
      const cacheObj = {};
      const now = Date.now();
      const expiry = now + this.ttl;

      for (const [username, data] of this.memoryCache.entries()) {
        cacheObj[username] = {
          location: data.location,
          accurate: data.accurate,
          expiry: expiry,
          cachedAt: now
        };
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
   * Removes from both memory and persistent storage
   */
  async clear() {
    this.memoryCache.clear();
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
}

if (typeof window !== 'undefined') {
  window.xflagCache = new CountryCache();
}
