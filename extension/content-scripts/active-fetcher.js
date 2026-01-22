// active fetcher with rate limiting, 429 handling, and viewport-first priority queue

/**
 * Priority levels for the request queue
 * Lower number = higher priority
 */
const PRIORITY = {
  VIEWPORT: 1,    // Currently visible in viewport (highest)
  HOVERED: 2,     // User is hovering over the element
  DEFAULT: 3      // All other requests (FIFO within this tier)
};

/**
 * QueueItem - Represents a queued fetch request with priority
 * @typedef {Object} QueueItem
 * @property {string} screenName - X username to fetch
 * @property {Function} resolve - Promise resolve function
 * @property {number} priority - Priority level (1=highest, 3=lowest)
 * @property {number} timestamp - When the request was added (for FIFO within same priority)
 * @property {HTMLElement|null} element - Associated DOM element (for viewport detection)
 */

/**
 * DeferredQueueItem - Represents an item in the deferred queue (rate-limited)
 * @typedef {Object} DeferredQueueItem
 * @property {string} screenName - X username to fetch
 * @property {HTMLElement|null} element - Associated DOM element
 * @property {number} addedTime - When the item was added to deferred queue
 */

/**
 * ActiveFetcher - Manages queue-based API requests with rate limiting and priority
 *
 * Implements conservative request strategy:
 * - 5-second minimum intervals between requests
 * - 5-minute cooldown on 429 rate limit errors
 * - Auto-retry queued users after cooldown
 * - Explicit state tracking (active/idle/rate-limited)
 * - Viewport-first priority queue (visible users processed first)
 * - Request deduplication via service worker (when available)
 * - Deferred queue for rate-limited requests with idle detection
 * - Viewport priority when processing deferred queue
 *
 * @class
 */
class ActiveFetcher {
  // Private class fields for encapsulation
  #minInterval = 5000; // 5 seconds between requests
  #cooldown429 = 300000; // 5 minute cooldown after 429
  #deferredInterval = 5000; // 5 seconds between deferred queue requests
  #idleThreshold = 60000; // 1 minute of no scroll = idle
  #lastRequestTime = 0;
  /** @type {QueueItem[]} Priority queue of requests */
  #requestQueue = [];
  #processing = false;
  #rateLimited = false;
  #paused = false;
  #capturedHeaders = null;
  #fetcherState = 'active'; // 'active' | 'idle' | 'rate-limited'
  #rateLimitTimer = null;

  // Viewport detection
  /** @type {IntersectionObserver|null} */
  #viewportObserver = null;
  /** @type {Set<HTMLElement>} Elements currently in viewport */
  #inViewportElements = new Set();
  /** @type {Map<string, HTMLElement>} Map of screenName -> element for priority updates */
  #screenNameToElement = new Map();
  /** @type {Set<string>} Currently hovered usernames */
  #hoveredUsernames = new Set();
  /** @type {number|null} Interval for periodic priority re-evaluation */
  #priorityUpdateInterval = null;

  // Deferred queue for rate-limited requests
  /** @type {DeferredQueueItem[]} Queue of requests deferred due to rate limiting */
  #deferredQueue = [];
  /** @type {boolean} Whether deferred queue is being processed */
  #processingDeferred = false;
  /** @type {number|null} Timer for deferred queue processing */
  #deferredProcessTimer = null;
  /** @type {Set<string>} Set of usernames in deferred queue for deduplication */
  #deferredUsernames = new Set();

  // Idle detection
  /** @type {number} Timestamp of last scroll event */
  #lastScrollTime = Date.now();
  /** @type {number|null} Interval for checking idle state */
  #idleCheckInterval = null;
  /** @type {boolean} Whether user is currently idle */
  #userIdle = false;
  /** @type {Function|null} Bound scroll handler for cleanup */
  #scrollHandler = null;

  // Rate limit end callback
  /** @type {Function|null} Callback when rate limit ends */
  #onRateLimitEnd = null;

  constructor() {
    this.#setupViewportObserver();
    this.#setupPriorityUpdateInterval();
    this.#setupIdleDetection();
  }

  /**
   * Set up IntersectionObserver for viewport detection
   * @private
   */
  #setupViewportObserver() {
    if (typeof IntersectionObserver === 'undefined') {
      console.warn('[xflags] IntersectionObserver not available, viewport priority disabled');
      return;
    }

    this.#viewportObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            this.#inViewportElements.add(entry.target);
          } else {
            this.#inViewportElements.delete(entry.target);
          }
        }
        // Re-evaluate priorities when viewport changes
        this.#updateQueuePriorities();
      },
      {
        root: null, // Use viewport
        rootMargin: '50px', // Slight margin for smoother experience
        threshold: 0.1 // Element is considered visible if 10% is shown
      }
    );
  }

  /**
   * Set up interval for periodic priority re-evaluation
   * Handles cases where elements scroll into/out of view without triggering observer
   * @private
   */
  #setupPriorityUpdateInterval() {
    // Re-evaluate priorities every 2 seconds
    this.#priorityUpdateInterval = setInterval(() => {
      if (this.#requestQueue.length > 0 && !this.#paused) {
        this.#updateQueuePriorities();
      }
    }, 2000);
  }

  /**
   * Set up idle detection for deferred queue processing
   * Tracks scroll events and checks for idle state periodically
   * @private
   */
  #setupIdleDetection() {
    // Debounced scroll handler
    let scrollTimeout = null;
    this.#scrollHandler = () => {
      this.#lastScrollTime = Date.now();

      // If user was idle, mark as active and pause deferred processing
      if (this.#userIdle) {
        this.#userIdle = false;
        console.log('[xflags] User active - pausing deferred queue processing');

        if (window.xflagConsole) {
          window.xflagConsole.log('info', 'User active - prioritizing viewport');
        }

        // Pause deferred processing to prioritize viewport
        this.#pauseDeferredProcessing();
      }

      // Debounce: after scrolling stops, check for viewport items to process
      clearTimeout(scrollTimeout);
      scrollTimeout = setTimeout(() => {
        // Re-prioritize deferred queue based on current viewport
        this.#reprioritizeDeferredQueue();

        // If not rate limited and deferred queue has items, try to process viewport items
        if (!this.#rateLimited && !this.#processingDeferred && this.#deferredQueue.length > 0) {
          // Check if there are viewport items to process
          const hasViewportItems = this.#deferredQueue.some(
            item => item.element && this.#isInViewport(item.element)
          );
          if (hasViewportItems) {
            console.log('[xflags] Scroll settled - processing viewport items from deferred queue');
            this.#startDeferredProcessing();
          }
        }
      }, 300);
    };

    window.addEventListener('scroll', this.#scrollHandler, { passive: true });

    // Check for idle state every 10 seconds
    this.#idleCheckInterval = setInterval(() => {
      const now = Date.now();
      const timeSinceScroll = now - this.#lastScrollTime;

      if (!this.#userIdle && timeSinceScroll >= this.#idleThreshold) {
        this.#userIdle = true;
        console.log('[xflags] User idle - starting deferred queue processing');

        if (window.xflagConsole) {
          window.xflagConsole.log('info', 'User idle - processing deferred queue');
        }

        // Start processing deferred queue if conditions are met
        if (!this.#rateLimited && this.#deferredQueue.length > 0) {
          this.#startDeferredProcessing();
        }
      }
    }, 10000);
  }

  /**
   * Check if an element is currently in the viewport
   * @param {HTMLElement} element - Element to check
   * @returns {boolean} True if in viewport
   * @private
   */
  #isInViewport(element) {
    if (!element || !document.contains(element)) {
      return false;
    }

    // First check our tracked set (from IntersectionObserver)
    if (this.#inViewportElements.has(element)) {
      return true;
    }

    // Fallback to getBoundingClientRect for immediate check
    const rect = element.getBoundingClientRect();
    return (
      rect.top < window.innerHeight + 50 &&
      rect.bottom > -50 &&
      rect.left < window.innerWidth + 50 &&
      rect.right > -50
    );
  }

  /**
   * Get priority for a queue item based on current state
   * @param {QueueItem} item - Queue item
   * @returns {number} Priority level
   * @private
   */
  #getPriorityForItem(item) {
    // Check if hovered
    if (this.#hoveredUsernames.has(item.screenName)) {
      return PRIORITY.HOVERED;
    }

    // Check if in viewport
    if (item.element && this.#isInViewport(item.element)) {
      return PRIORITY.VIEWPORT;
    }

    return PRIORITY.DEFAULT;
  }

  /**
   * Update priorities for all items in the queue
   * @private
   */
  #updateQueuePriorities() {
    let changed = false;

    for (const item of this.#requestQueue) {
      const newPriority = this.#getPriorityForItem(item);
      if (item.priority !== newPriority) {
        item.priority = newPriority;
        changed = true;
      }
    }

    if (changed) {
      // Re-sort queue by priority, then by timestamp
      this.#sortQueue();
    }
  }

  /**
   * Sort the queue by priority (ascending) then by timestamp (ascending)
   * @private
   */
  #sortQueue() {
    this.#requestQueue.sort((a, b) => {
      // Primary sort: priority (lower = higher priority)
      if (a.priority !== b.priority) {
        return a.priority - b.priority;
      }
      // Secondary sort: timestamp (earlier = processed first, FIFO within same priority)
      return a.timestamp - b.timestamp;
    });
  }

  /**
   * Register an element for viewport tracking
   * @param {string} screenName - X username
   * @param {HTMLElement} element - DOM element to track
   */
  trackElement(screenName, element) {
    if (!element || !this.#viewportObserver) return;

    this.#screenNameToElement.set(screenName, element);
    this.#viewportObserver.observe(element);
  }

  /**
   * Untrack an element from viewport observer
   * @param {string} screenName - X username
   */
  untrackElement(screenName) {
    const element = this.#screenNameToElement.get(screenName);
    if (element && this.#viewportObserver) {
      this.#viewportObserver.unobserve(element);
      this.#inViewportElements.delete(element);
    }
    this.#screenNameToElement.delete(screenName);
  }

  /**
   * Set a username as hovered (higher priority)
   * @param {string} screenName - X username
   */
  setHovered(screenName) {
    this.#hoveredUsernames.add(screenName);
    this.#updateQueuePriorities();
  }

  /**
   * Remove hover state from a username
   * @param {string} screenName - X username
   */
  clearHovered(screenName) {
    this.#hoveredUsernames.delete(screenName);
    this.#updateQueuePriorities();
  }

  /**
   * Set authentication headers for API requests
   * @param {Object} headers - Headers object containing authorization and CSRF token
   * @returns {boolean} True if headers are valid and set, false otherwise
   */
  setHeaders(headers) {
    if (!headers || !headers.authorization || !headers['x-csrf-token']) {
      return false;
    }

    const hadHeaders = !!this.#capturedHeaders;
    this.#capturedHeaders = headers;

    // If this is the first time headers are captured and queue has items, start processing
    if (!hadHeaders && this.#requestQueue.length > 0 && !this.#processing && !this.#rateLimited) {
      console.log(`[xflags] Headers captured, processing ${this.#requestQueue.length} queued items`);
      this.#processQueue();
    }

    return true;
  }

  /**
   * Get current fetcher state
   * @returns {string} Current state: 'active', 'idle', or 'rate-limited'
   */
  getState() {
    return this.#fetcherState;
  }

  /**
   * Fetch user location from X API
   * Uses service worker for deduplication when available
   * @param {string} screenName - X username (without @)
   * @param {HTMLElement} [element] - Optional DOM element for viewport priority
   * @returns {Promise<Object|null>} Location data {location: string, accurate: boolean} or null
   */
  async fetchUserLocation(screenName, element = null) {
    if (!screenName) return null;

    // Check if already in queue
    if (this.#requestQueue.some(item => item.screenName === screenName)) {
      console.log(`[xflags] @${screenName} already in queue, skipping`);
      // Update element reference if provided
      if (element) {
        const existing = this.#requestQueue.find(item => item.screenName === screenName);
        if (existing && !existing.element) {
          existing.element = element;
          this.trackElement(screenName, element);
        }
      }
      return null;
    }

    // Try service worker deduplication first
    if (window.xflagCache && window.xflagCache.isUsingServiceWorker()) {
      try {
        const result = await window.xflagCache.requestLocation(screenName);

        if (result.cached || result.waited) {
          // Data was available from cache or another tab's request
          console.log(`[xflags] @${screenName} found in service worker cache, data:`, result.data);

          // Post message to update the flag (processTweet doesn't use return value)
          if (result.data) {
            const location = result.data.location || result.data.country || result.data;
            const accurate = result.data.accurate !== false;
            console.log(`[xflags] @${screenName} posting cached location: ${location}`);
            window.postMessage({
              type: 'XFLAG_FETCH_RESPONSE',
              screenName: screenName,
              location: typeof location === 'string' ? location : null,
              accurate: accurate
            }, window.location.origin);
          }
          return result.data;
        }

        if (!result.shouldFetch) {
          // Another tab is already fetching, wait handled by service worker
          console.log(`[xflags] @${screenName} being fetched by another tab`);
          return null;
        }
      } catch (error) {
        // Fall through to local queue
        console.warn('[xflags] Service worker request failed, using local queue:', error);
      }
    }

    // Track element for viewport detection
    if (element) {
      this.trackElement(screenName, element);
    }

    // Determine initial priority
    const initialPriority = this.#hoveredUsernames.has(screenName)
      ? PRIORITY.HOVERED
      : (element && this.#isInViewport(element))
        ? PRIORITY.VIEWPORT
        : PRIORITY.DEFAULT;

    return new Promise((resolve) => {
      /** @type {QueueItem} */
      const queueItem = {
        screenName,
        resolve,
        priority: initialPriority,
        timestamp: Date.now(),
        element: element || this.#screenNameToElement.get(screenName) || null
      };

      this.#requestQueue.push(queueItem);
      this.#sortQueue();
      console.log(`[xflags] Queued @${screenName} (priority: ${initialPriority}, queue size: ${this.#requestQueue.length}, headers: ${!!this.#capturedHeaders})`);

      // Update state to active when items are queued
      if (this.#fetcherState === 'idle') {
        this.#fetcherState = 'active';
        if (window.xflagConsole && window.xflagConsole.setFetcherState) {
          window.xflagConsole.setFetcherState('active');
        }
      }

      if (!this.#processing && !this.#rateLimited) {
        this.#processQueue();
      }
    });
  }

  /**
   * Process queued requests with rate limiting
   * Enforces 5-second intervals between requests
   * Always picks highest priority item first
   * @private
   */
  async #processQueue() {
    if (this.#processing || this.#rateLimited || this.#paused) return;
    if (this.#requestQueue.length === 0) return;

    // Don't process queue until headers are captured
    // Items will be processed once setHeaders() is called
    if (!this.#capturedHeaders) {
      return;
    }

    this.#processing = true;

    // Update state to active when starting to process queue
    if (this.#fetcherState === 'idle') {
      this.#fetcherState = 'active';
      if (window.xflagConsole && window.xflagConsole.setFetcherState) {
        window.xflagConsole.setFetcherState('active');
      }
    }

    while (this.#requestQueue.length > 0 && !this.#rateLimited && !this.#paused) {
      // Re-evaluate and sort priorities before picking next item
      this.#updateQueuePriorities();

      // Rate limiting: enforce minimum interval
      const now = Date.now();
      const timeSinceLastRequest = now - this.#lastRequestTime;

      if (timeSinceLastRequest < this.#minInterval) {
        const waitTime = this.#minInterval - timeSinceLastRequest;
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }

      // Get highest priority item (first in sorted queue)
      const item = this.#requestQueue.shift();
      const { screenName, resolve, element } = item;

      this.#lastRequestTime = Date.now();

      try {
        const data = await this.#makeRequest(screenName);

        // Notify service worker that request is complete
        if (window.xflagCache && window.xflagCache.isUsingServiceWorker()) {
          await window.xflagCache.completeRequest(screenName, data);
        }

        resolve(data);
      } catch (error) {
        // Notify service worker of failure
        if (window.xflagCache && window.xflagCache.isUsingServiceWorker()) {
          await window.xflagCache.completeRequest(screenName, null);
        }

        resolve(null);
      }

      // Clean up tracking
      this.untrackElement(screenName);

      // Small delay to be extra safe
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    this.#processing = false;

    // Update state to idle when queue is empty
    if (this.#requestQueue.length === 0 && !this.#rateLimited) {
      this.#fetcherState = 'idle';
      if (window.xflagConsole && window.xflagConsole.setFetcherState) {
        window.xflagConsole.setFetcherState('idle');
      }
    }
  }

  /**
   * Validate API response structure
   * @param {Object} data - Parsed API response
   * @param {string} screenName - Username being queried
   * @returns {{isValid: boolean, accountBasedIn: string|null, locationAccurate: boolean|null}}
   * @private
   */
  #validateAPIResponse(data, screenName) {
    const result = {
      isValid: false,
      accountBasedIn: null,
      locationAccurate: null
    };

    if (!data || typeof data !== 'object') {
      console.warn(`[xflags] Invalid API response for @${screenName}: not an object`);
      return result;
    }

    if (data.errors && Array.isArray(data.errors)) {
      const errorMessages = data.errors.map(e => e.message || 'Unknown error').join(', ');
      console.warn(`[xflags] API error for @${screenName}: ${errorMessages}`);
      return result;
    }

    if (!data.data) {
      console.warn(`[xflags] Unexpected API response structure for @${screenName}: missing 'data' field`);
      return result;
    }

    const userResult = data.data?.user_result_by_screen_name?.result;

    if (!userResult) {
      console.log(`[xflags] No user result for @${screenName} (may not exist or be suspended)`);
      return result;
    }

    if (userResult.__typename === 'UserUnavailable') {
      console.log(`[xflags] User @${screenName} is unavailable`);
      return result;
    }

    const aboutProfile = userResult.about_profile;

    if (!aboutProfile) {
      console.log(`[xflags] No about_profile for @${screenName}`);
      return result;
    }

    result.isValid = true;
    result.accountBasedIn = aboutProfile.account_based_in || null;
    result.locationAccurate = aboutProfile.location_accurate;

    return result;
  }

  /**
   * Make AboutAccountQuery API request for a specific user
   * @param {string} screenName - X username (without @)
   * @returns {Promise<Object|null>} Location data or null if unavailable
   * @private
   */
  async #makeRequest(screenName) {
    if (!this.#capturedHeaders) {
      // This should not happen with the queue guard, but log if it does
      console.warn(`[xflags] Cannot fetch @${screenName} - no headers captured yet`);
      return null;
    }

    if (this.#rateLimited) {
      return null;
    }

    const url = `https://x.com/i/api/graphql/XRqGa7EeokUU5kppkh13EA/AboutAccountQuery?variables=${encodeURIComponent(JSON.stringify({ screenName }))}`;

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'authorization': this.#capturedHeaders.authorization,
          'x-csrf-token': this.#capturedHeaders['x-csrf-token'],
          'x-twitter-auth-type': this.#capturedHeaders['x-twitter-auth-type'] || 'OAuth2Session',
          'x-twitter-active-user': this.#capturedHeaders['x-twitter-active-user'] || 'yes',
          'x-twitter-client-language': this.#capturedHeaders['x-twitter-client-language'] || 'en',
          'content-type': 'application/json'
        },
        credentials: 'include'
      });

      if (response.status === 429) {
        console.warn('[xflags] 429 Rate Limited - pausing for 5 minutes');

        if (window.xflagConsole) {
          window.xflagConsole.log('error', '429 Rate Limited - pausing for 5 minutes');
        }

        if (window.xflagLogger) {
          window.xflagLogger.log429Error();
        }

        // Notify service worker of rate limit
        if (window.xflagCache && window.xflagCache.isUsingServiceWorker()) {
          await window.xflagCache.setRateLimitStatus(true);
        }

        this.#handleRateLimit();
        return null;
      }

      if (!response.ok) {
        console.error(`[xflags] Fetch failed for @${screenName}: ${response.status}`);

        // Log error if error logging is enabled
        this.#logError({
          action: 'fetchUserLocation',
          message: `HTTP ${response.status}: ${response.statusText}`,
          context: { username: screenName, status: response.status }
        });

        return null;
      }

      const data = await response.json();
      const validation = this.#validateAPIResponse(data, screenName);

      if (!validation.isValid || !validation.accountBasedIn) {
        console.log(`[xflags] No location data for @${screenName}`);

        window.postMessage({
          type: 'XFLAG_FETCH_RESPONSE',
          screenName: screenName,
          location: 'undefined',
          accurate: false
        }, window.location.origin);

        return null;
      }

      const accountBasedIn = validation.accountBasedIn;
      const locationAccurate = validation.locationAccurate !== false;

      console.log(`[xflags] Fetched: @${screenName} -> ${accountBasedIn} (accurate: ${locationAccurate})`);

      if (window.xflagConsole) {
        const accurateText = locationAccurate ? 'accurate' : 'VPN/inaccurate';
        window.xflagConsole.log('fetch', `Fetched @${screenName} -> ${accountBasedIn} (${accurateText})`);
      }

      if (window.xflagLogger) {
        window.xflagLogger.logFlagFetched(screenName, accountBasedIn, locationAccurate);
      }

      window.postMessage({
        type: 'XFLAG_FETCH_RESPONSE',
        screenName: screenName,
        location: accountBasedIn,
        accurate: locationAccurate
      }, window.location.origin);

      return {
        location: accountBasedIn,
        accurate: locationAccurate
      };

    } catch (error) {
      console.error(`[xflags] Error fetching @${screenName}:`, error);

      // Log error
      this.#logError({
        action: 'fetchUserLocation',
        message: error.message,
        stack: error.stack,
        context: { username: screenName }
      });

      return null;
    }
  }

  /**
   * Log an error to the service worker error collector
   * @param {Object} errorData - Error data
   * @private
   */
  async #logError(errorData) {
    if (window.xflagBrowser && window.SW_MESSAGE_TYPES) {
      try {
        await window.xflagBrowser.runtime.sendMessage({
          type: window.SW_MESSAGE_TYPES.ERROR_LOG,
          error: errorData
        });
      } catch (e) {
        // Ignore errors when logging errors
      }
    }
  }

  // ============================================
  // DEFERRED QUEUE METHODS
  // ============================================

  /**
   * Add items to the deferred queue when rate limited
   * @param {Array<{screenName: string, element: HTMLElement|null}>} items - Items to defer
   * @private
   */
  #addToDeferredQueue(items) {
    const now = Date.now();

    for (const item of items) {
      // Skip if already in deferred queue
      if (this.#deferredUsernames.has(item.screenName)) {
        continue;
      }

      this.#deferredQueue.push({
        screenName: item.screenName,
        element: item.element,
        addedTime: now
      });
      this.#deferredUsernames.add(item.screenName);

      // Track element for viewport detection
      if (item.element) {
        this.trackElement(item.screenName, item.element);
      }
    }

    // Sort deferred queue by viewport priority
    this.#reprioritizeDeferredQueue();

    console.log(`[xflags] Deferred queue now has ${this.#deferredQueue.length} items`);
  }

  /**
   * Re-prioritize deferred queue based on viewport visibility
   * Items in viewport come first
   * @private
   */
  #reprioritizeDeferredQueue() {
    if (this.#deferredQueue.length === 0) return;

    this.#deferredQueue.sort((a, b) => {
      const aInViewport = a.element && this.#isInViewport(a.element);
      const bInViewport = b.element && this.#isInViewport(b.element);

      // Viewport items first
      if (aInViewport && !bInViewport) return -1;
      if (!aInViewport && bInViewport) return 1;

      // Then by added time (FIFO)
      return a.addedTime - b.addedTime;
    });
  }

  /**
   * Start processing the deferred queue
   * Called when cooldown ends or user becomes idle
   * @private
   */
  #startDeferredProcessing() {
    if (this.#processingDeferred || this.#rateLimited || this.#paused) {
      return;
    }

    if (this.#deferredQueue.length === 0) {
      return;
    }

    this.#processingDeferred = true;
    console.log(`[xflags] Starting deferred queue processing (${this.#deferredQueue.length} items)`);

    if (window.xflagConsole) {
      window.xflagConsole.log('info', `Processing deferred queue (${this.#deferredQueue.length} items)`);
    }

    this.#processDeferredItem();
  }

  /**
   * Process a single item from the deferred queue
   * @private
   */
  async #processDeferredItem() {
    // Check if we should continue processing
    if (!this.#processingDeferred || this.#rateLimited || this.#paused) {
      this.#processingDeferred = false;
      return;
    }

    if (this.#deferredQueue.length === 0) {
      this.#processingDeferred = false;
      console.log('[xflags] Deferred queue empty');

      if (window.xflagConsole) {
        window.xflagConsole.log('info', 'Deferred queue processing complete');
      }
      return;
    }

    // Re-prioritize based on current viewport
    this.#reprioritizeDeferredQueue();

    // Check if user is active (not idle)
    // If active, only process viewport items to avoid background fetching
    if (!this.#userIdle) {
      // Check if the first item (highest priority) is in viewport
      const firstItem = this.#deferredQueue[0];
      const isFirstInViewport = firstItem.element && this.#isInViewport(firstItem.element);

      if (!isFirstInViewport) {
        // No viewport items to process and user is active - pause
        console.log('[xflags] User active, no viewport items - pausing deferred processing');
        this.#processingDeferred = false;
        return;
      }
      // Otherwise, continue processing the viewport item
    }

    // Get next item (highest priority = first in sorted array)
    const item = this.#deferredQueue.shift();
    this.#deferredUsernames.delete(item.screenName);

    // Check if element is still in DOM
    if (item.element && !document.contains(item.element)) {
      // Element was removed, skip and process next
      console.log(`[xflags] Skipping @${item.screenName} - element no longer in DOM`);
      this.#scheduleDeferredItem(100); // Short delay before next
      return;
    }

    // Convert rate-limited indicator back to loading
    if (item.element && window.xflagRenderer) {
      window.xflagRenderer.convertToLoading(item.element, item.screenName);
    }

    // Also convert any other rate-limited elements for this username
    this.#convertAllRateLimitedForUsername(item.screenName);

    // Notify that we're about to fetch
    window.postMessage({
      type: 'XFLAG_DEFERRED_PROCESSING',
      screenName: item.screenName
    }, window.location.origin);

    // Fetch the user location
    try {
      await this.fetchUserLocation(item.screenName, item.element);
    } catch (error) {
      console.error(`[xflags] Error fetching deferred @${item.screenName}:`, error);
    }

    // Clean up tracking
    this.untrackElement(item.screenName);

    // Schedule next item with interval
    this.#scheduleDeferredItem(this.#deferredInterval);
  }

  /**
   * Convert all rate-limited elements for a username back to loading state
   * Called when deferred processing starts for a username
   * @param {string} screenName - X username
   * @private
   */
  #convertAllRateLimitedForUsername(screenName) {
    // Query DOM for all rate-limited flags and convert ones matching this username
    const rateLimitedFlags = document.querySelectorAll('[data-xflag][data-rate-limited="true"]');
    for (const flag of rateLimitedFlags) {
      const container = flag.closest('article[data-testid="tweet"], [data-testid="UserCell"]');
      if (container && window.xflagObserver) {
        const username = window.xflagObserver.extractUsername(container);
        if (username === screenName && window.xflagRenderer) {
          window.xflagRenderer.convertToLoading(container, screenName);
        }
      }
    }
  }

  /**
   * Schedule the next deferred item processing
   * @param {number} delay - Delay in milliseconds
   * @private
   */
  #scheduleDeferredItem(delay) {
    if (this.#deferredProcessTimer) {
      clearTimeout(this.#deferredProcessTimer);
    }

    this.#deferredProcessTimer = setTimeout(() => {
      this.#deferredProcessTimer = null;
      this.#processDeferredItem();
    }, delay);
  }

  /**
   * Pause deferred queue processing
   * @private
   */
  #pauseDeferredProcessing() {
    this.#processingDeferred = false;

    if (this.#deferredProcessTimer) {
      clearTimeout(this.#deferredProcessTimer);
      this.#deferredProcessTimer = null;
    }
  }

  /**
   * Add a single item to the deferred queue
   * Called when rate limited during normal processing
   * @param {string} screenName - X username
   * @param {HTMLElement|null} element - Associated DOM element
   * @param {boolean} [alreadyConverted=false] - Whether element already shows rate-limited state
   */
  addToDeferred(screenName, element, alreadyConverted = false) {
    // Convert the element to rate-limited state if it has a loading flag
    // Skip if already converted (caller handled it) or if element already shows rate-limited
    if (element && window.xflagRenderer && !alreadyConverted) {
      // Check if element has a loading flag to convert
      const displayNameElement = element.querySelector('[data-testid="UserName"] a span, [data-testid="User-Name"] a span');
      const existingFlag = displayNameElement?.parentNode?.parentNode?.querySelector('[data-xflag]');
      const isLoadingFlag = existingFlag && existingFlag.getAttribute('data-loading') === 'true';

      if (isLoadingFlag) {
        window.xflagRenderer.convertToRateLimited(element, screenName);
      }
    }

    // If already in deferred queue, don't add duplicate
    if (this.#deferredUsernames.has(screenName)) {
      // Still track the new element for viewport detection
      if (element) {
        this.trackElement(screenName, element);
      }
      return;
    }

    this.#deferredQueue.push({
      screenName,
      element,
      addedTime: Date.now()
    });
    this.#deferredUsernames.add(screenName);

    if (element) {
      this.trackElement(screenName, element);
    }

    this.#reprioritizeDeferredQueue();
  }

  /**
   * Remove an item from the deferred queue
   * Called when user navigates away or element is removed
   * @param {string} screenName - X username
   */
  removeFromDeferred(screenName) {
    const index = this.#deferredQueue.findIndex(item => item.screenName === screenName);
    if (index !== -1) {
      this.#deferredQueue.splice(index, 1);
      this.#deferredUsernames.delete(screenName);
      this.untrackElement(screenName);
    }
  }

  /**
   * Check if a username is in the deferred queue
   * @param {string} screenName - X username
   * @returns {boolean} True if in deferred queue
   */
  isDeferred(screenName) {
    return this.#deferredUsernames.has(screenName);
  }

  /**
   * Get deferred queue statistics
   * @returns {{total: number, inViewport: number, outOfViewport: number}}
   */
  getDeferredStats() {
    let inViewport = 0;
    let outOfViewport = 0;

    for (const item of this.#deferredQueue) {
      if (item.element && this.#isInViewport(item.element)) {
        inViewport++;
      } else {
        outOfViewport++;
      }
    }

    return {
      total: this.#deferredQueue.length,
      inViewport,
      outOfViewport
    };
  }

  /**
   * Set callback for when rate limit ends
   * @param {Function} callback - Callback function
   */
  onRateLimitEnd(callback) {
    this.#onRateLimitEnd = callback;
  }

  // ============================================
  // RATE LIMIT HANDLING (UPDATED)
  // ============================================

  /**
   * Handle 429 rate limit error
   * @private
   */
  #handleRateLimit() {
    this.#rateLimited = true;
    this.#fetcherState = 'rate-limited';

    // Pause any deferred processing
    this.#pauseDeferredProcessing();

    if (this.#rateLimitTimer !== null) {
      clearTimeout(this.#rateLimitTimer);
      this.#rateLimitTimer = null;
    }

    // Save queued usernames and add to deferred queue
    const queuedItems = this.#requestQueue.map(item => ({
      screenName: item.screenName,
      element: item.element
    }));

    // Notify main.js to convert loading flags to rate-limited state
    this.#requestQueue.forEach(({ screenName, resolve }) => {
      window.postMessage({
        type: 'XFLAG_RATE_LIMITED',
        screenName,
      }, window.location.origin);
      resolve(null);
    });

    this.#requestQueue = [];

    // Add to deferred queue
    this.#addToDeferredQueue(queuedItems);

    console.log(`[xflags] Rate limited. Added ${queuedItems.length} users to deferred queue`);

    if (window.xflagConsole) {
      window.xflagConsole.log('status', `Rate limited. ${queuedItems.length} users queued for later`);
      window.xflagConsole.log('status', 'Entering 5-minute cooldown...');
      if (window.xflagConsole.setFetcherState) {
        window.xflagConsole.setFetcherState('rate-limited');
      }
    }

    this.#rateLimitTimer = setTimeout(async () => {
      this.#rateLimitTimer = null;
      this.#rateLimited = false;
      this.#fetcherState = this.#deferredQueue.length > 0 ? 'active' : 'idle';
      console.log('[xflags] Cooldown complete, resuming operations');

      // Notify service worker that rate limit is cleared
      if (window.xflagCache && window.xflagCache.isUsingServiceWorker()) {
        await window.xflagCache.setRateLimitStatus(false);
      }

      if (window.xflagConsole) {
        window.xflagConsole.log('status', 'Cooldown complete, resuming operations');
        if (window.xflagConsole.setFetcherState) {
          window.xflagConsole.setFetcherState(this.#fetcherState);
        }
      }

      // Notify callback if set
      if (this.#onRateLimitEnd) {
        this.#onRateLimitEnd();
      }

      // Start processing deferred queue if user is idle or queue has viewport items
      if (this.#deferredQueue.length > 0) {
        console.log(`[xflags] Processing ${this.#deferredQueue.length} deferred users`);

        if (window.xflagConsole) {
          window.xflagConsole.log('info', `Processing ${this.#deferredQueue.length} deferred users`);
        }

        // Always start processing - viewport items get priority
        this.#startDeferredProcessing();
      }
    }, this.#cooldown429);
  }

  /**
   * Check if currently rate limited
   * @returns {boolean} True if rate limited
   */
  isRateLimited() {
    return this.#rateLimited;
  }

  /**
   * Get current queue size
   * @returns {number} Number of pending requests
   */
  getQueueSize() {
    return this.#requestQueue.length;
  }

  /**
   * Get queue statistics
   * @returns {{total: number, viewport: number, hovered: number, default: number}}
   */
  getQueueStats() {
    const stats = {
      total: this.#requestQueue.length,
      viewport: 0,
      hovered: 0,
      default: 0
    };

    for (const item of this.#requestQueue) {
      switch (item.priority) {
        case PRIORITY.VIEWPORT:
          stats.viewport++;
          break;
        case PRIORITY.HOVERED:
          stats.hovered++;
          break;
        default:
          stats.default++;
      }
    }

    return stats;
  }

  /**
   * Pause the fetcher
   */
  pause() {
    this.#paused = true;
    console.log('[xflags] Fetcher paused - queued requests will not be processed');
  }

  /**
   * Resume the fetcher
   */
  resume() {
    this.#paused = false;
    console.log('[xflags] Fetcher resumed - processing queued requests');

    if (this.#requestQueue.length > 0 && !this.#processing && !this.#rateLimited) {
      this.#processQueue();
    }
  }

  /**
   * Check if fetcher is paused
   * @returns {boolean} True if paused
   */
  isPaused() {
    return this.#paused;
  }

  /**
   * Clean up resources (call when extension is disabled/unloaded)
   */
  destroy() {
    if (this.#viewportObserver) {
      this.#viewportObserver.disconnect();
      this.#viewportObserver = null;
    }

    if (this.#priorityUpdateInterval) {
      clearInterval(this.#priorityUpdateInterval);
      this.#priorityUpdateInterval = null;
    }

    if (this.#rateLimitTimer) {
      clearTimeout(this.#rateLimitTimer);
      this.#rateLimitTimer = null;
    }

    if (this.#idleCheckInterval) {
      clearInterval(this.#idleCheckInterval);
      this.#idleCheckInterval = null;
    }

    if (this.#deferredProcessTimer) {
      clearTimeout(this.#deferredProcessTimer);
      this.#deferredProcessTimer = null;
    }

    if (this.#scrollHandler) {
      window.removeEventListener('scroll', this.#scrollHandler);
      this.#scrollHandler = null;
    }

    this.#inViewportElements.clear();
    this.#screenNameToElement.clear();
    this.#hoveredUsernames.clear();
    this.#requestQueue = [];
    this.#deferredQueue = [];
    this.#deferredUsernames.clear();
  }
}

if (typeof window !== 'undefined') {
  window.xflagFetcher = new ActiveFetcher();

  // Export priority constants
  window.XFLAG_PRIORITY = PRIORITY;
}
