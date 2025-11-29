// active fetcher with rate limiting and 429 handling

/**
 * ActiveFetcher - Manages queue-based API requests with rate limiting
 *
 * Implements conservative request strategy:
 * - 5-second minimum intervals between requests
 * - 5-minute cooldown on 429 rate limit errors
 * - Auto-retry queued users after cooldown
 * - Explicit state tracking (active/idle/rate-limited)
 *
 * @class
 */
class ActiveFetcher {
  constructor() {
    this.MIN_INTERVAL = 5000; // 5 seconds between requests
    this.COOLDOWN_429 = 300000; // 5 minute cooldown after 429
    this.lastRequestTime = 0;
    this.requestQueue = [];
    this.processing = false;
    this.rateLimited = false;
    this.paused = false;
    this.capturedHeaders = null;
    this.fetcherState = 'active'; // 'active' | 'idle' | 'rate-limited'
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

    this.capturedHeaders = headers;
    return true;
  }

  /**
   * Get current fetcher state
   * @returns {string} Current state: 'active', 'idle', or 'rate-limited'
   */
  getState() {
    return this.fetcherState;
  }

  /**
   * Fetch user location from X API
   * Queues request and processes with rate limiting
   * @param {string} screenName - X username (without @)
   * @returns {Promise<Object|null>} Location data {location: string, accurate: boolean} or null
   */
  async fetchUserLocation(screenName) {
    if (!screenName) return null;

    if (this.requestQueue.some(item => item.screenName === screenName)) {
      return null;
    }

    return new Promise((resolve) => {
      this.requestQueue.push({ screenName, resolve });

      // update state to active when items are queued
      if (this.fetcherState === 'idle') {
        this.fetcherState = 'active';
        if (window.xflagConsole && window.xflagConsole.setFetcherState) {
          window.xflagConsole.setFetcherState('active');
        }
      }

      if (!this.processing && !this.rateLimited) {
        this.processQueue();
      }
    });
  }

  /**
   * Process queued requests with rate limiting
   * Enforces 5-second intervals between requests
   * Updates fetcher state (active/idle) based on queue status
   * @private
   */
  async processQueue() {
    if (this.processing || this.rateLimited || this.paused) return;
    if (this.requestQueue.length === 0) return;

    this.processing = true;

    // update state to active when starting to process queue
    if (this.fetcherState === 'idle') {
      this.fetcherState = 'active';
      if (window.xflagConsole && window.xflagConsole.setFetcherState) {
        window.xflagConsole.setFetcherState('active');
      }
    }

    while (this.requestQueue.length > 0 && !this.rateLimited && !this.paused) {
      // rate limiting: enforce minimum interval
      const now = Date.now();
      const timeSinceLastRequest = now - this.lastRequestTime;

      if (timeSinceLastRequest < this.MIN_INTERVAL) {
        const waitTime = this.MIN_INTERVAL - timeSinceLastRequest;
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }

      const { screenName, resolve } = this.requestQueue.shift();
      this.lastRequestTime = Date.now();

      try {
        const data = await this.makeRequest(screenName);
        resolve(data);
      } catch (error) {
        resolve(null);
      }

      // small delay to be extra safe
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    this.processing = false;

    // update state to idle when queue is empty
    if (this.requestQueue.length === 0 && !this.rateLimited) {
      this.fetcherState = 'idle';
      if (window.xflagConsole && window.xflagConsole.setFetcherState) {
        window.xflagConsole.setFetcherState('idle');
      }
    }
  }

  /**
   * Make AboutAccountQuery API request for a specific user
   * Handles 429 rate limiting and logs to console/logger
   * @param {string} screenName - X username (without @)
   * @returns {Promise<Object|null>} Location data or null if unavailable
   * @private
   */
  async makeRequest(screenName) {
    if (!this.capturedHeaders) {
      return null;
    }

    if (this.rateLimited) {
      return null;
    }

    const url = `https://x.com/i/api/graphql/XRqGa7EeokUU5kppkh13EA/AboutAccountQuery?variables=${encodeURIComponent(JSON.stringify({ screenName }))}`;

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'authorization': this.capturedHeaders.authorization,
          'x-csrf-token': this.capturedHeaders['x-csrf-token'],
          'x-twitter-auth-type': this.capturedHeaders['x-twitter-auth-type'] || 'OAuth2Session',
          'x-twitter-active-user': this.capturedHeaders['x-twitter-active-user'] || 'yes',
          'x-twitter-client-language': this.capturedHeaders['x-twitter-client-language'] || 'en',
          'content-type': 'application/json'
        },
        credentials: 'include'
      });

      if (response.status === 429) {
        console.warn('[xflags] ⚠️ 429 Rate Limited - pausing for 5 minutes');

        if (window.xflagConsole) {
          window.xflagConsole.log('error', '429 Rate Limited - pausing for 5 minutes');
        }

        if (window.xflagLogger) {
          window.xflagLogger.log429Error();
        }

        this.handleRateLimit();
        return null;
      }

      if (!response.ok) {
        console.error(`[xflags] Fetch failed for @${screenName}: ${response.status}`);
        return null;
      }

      const data = await response.json();

      const accountBasedIn = data?.data?.user_result_by_screen_name?.result?.about_profile?.account_based_in;
      const locationAccurate = data?.data?.user_result_by_screen_name?.result?.about_profile?.location_accurate;

      if (accountBasedIn) {
        console.log(`[xflags] ✓ Fetched: @${screenName} → ${accountBasedIn} (accurate: ${locationAccurate !== false})`);

        if (window.xflagConsole) {
          const accurateText = locationAccurate !== false ? 'accurate' : 'VPN/inaccurate';
          window.xflagConsole.log('fetch', `Fetched @${screenName} → ${accountBasedIn} (${accurateText})`);
        }

        if (window.xflagLogger) {
          window.xflagLogger.logFlagFetched(screenName, accountBasedIn, locationAccurate !== false);
        }

        window.postMessage({
          type: 'XFLAG_FETCH_RESPONSE',
          screenName: screenName,
          location: accountBasedIn,
          accurate: locationAccurate !== false
        }, '*');

        return {
          location: accountBasedIn,
          accurate: locationAccurate !== false
        };
      } else {
        console.log(`[xflags] No location data for @${screenName}`);

        window.postMessage({
          type: 'XFLAG_FETCH_RESPONSE',
          screenName: screenName,
          location: 'undefined',  // special value for no location
          accurate: false
        }, '*');

        return null;
      }

    } catch (error) {
      console.error(`[xflags] Error fetching @${screenName}:`, error);
      return null;
    }
  }

  /**
   * Handle 429 rate limit error
   * Saves queued usernames and retries them after 5-minute cooldown
   * Clears loading flags and updates fetcher state to 'rate-limited'
   * @private
   */
  handleRateLimit() {
    this.rateLimited = true;
    this.fetcherState = 'rate-limited';

    // Save usernames before clearing queue - they'll be retried after cooldown
    // This prevents loading flags from getting stuck when rate limited
    const queuedUsernames = this.requestQueue.map(({ screenName }) => screenName);

    // send null responses to clear current loading states
    this.requestQueue.forEach(({ screenName, resolve }) => {
      window.postMessage({
        type: 'XFLAG_FETCH_RESPONSE',
        screenName,
        location: null,
        accurate: false
      }, '*');
      resolve(null);
    });

    this.requestQueue = [];

    console.log(`[xflags] Rate limited. Queued ${queuedUsernames.length} users for retry after cooldown`);

    if (window.xflagConsole) {
      window.xflagConsole.log('status', `Rate limited. Queued ${queuedUsernames.length} users for retry after cooldown`);
      window.xflagConsole.log('status', 'Entering 5-minute cooldown...');
      if (window.xflagConsole.setFetcherState) {
        window.xflagConsole.setFetcherState('rate-limited');
      }
    }

    setTimeout(() => {
      this.rateLimited = false;
      this.fetcherState = 'active';
      console.log('[xflags] ✓ Cooldown complete, resuming operations');

      if (window.xflagConsole) {
        window.xflagConsole.log('status', 'Cooldown complete, resuming operations');
        if (window.xflagConsole.setFetcherState) {
          window.xflagConsole.setFetcherState('active');
        }
      }

      // auto-retry queued usernames
      if (queuedUsernames.length > 0) {
        console.log(`[xflags] Retrying ${queuedUsernames.length} queued users`);
        if (window.xflagConsole) {
          window.xflagConsole.log('info', `Retrying ${queuedUsernames.length} queued users`);
        }

        queuedUsernames.forEach(screenName => {
          this.fetchUserLocation(screenName);
        });
      }
    }, this.COOLDOWN_429);
  }

  isRateLimited() {
    return this.rateLimited;
  }

  getQueueSize() {
    return this.requestQueue.length;
  }

  pause() {
    this.paused = true;
    console.log('[xflags] Fetcher paused - queued requests will not be processed');
  }

  resume() {
    this.paused = false;
    console.log('[xflags] Fetcher resumed - processing queued requests');

    if (this.requestQueue.length > 0 && !this.processing && !this.rateLimited) {
      this.processQueue();
    }
  }

  isPaused() {
    return this.paused;
  }
}

if (typeof window !== 'undefined') {
  window.xflagFetcher = new ActiveFetcher();
}
