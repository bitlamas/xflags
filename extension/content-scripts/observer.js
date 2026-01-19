// mutation observer for detecting new tweets

/**
 * TweetObserver - MutationObserver wrapper for detecting new tweets and user cells
 *
 * Features:
 * - Watches for new tweet elements added to the DOM
 * - Debounced processing to avoid performance issues
 * - Pause/resume support for extension toggle
 * - Automatic retry if main content not found on startup
 *
 * @class
 */
class TweetObserver {
  /**
   * Create a new TweetObserver
   */
  constructor() {
    /** @type {MutationObserver|null} */
    this.observer = null;

    /** @type {Set<HTMLElement>} Queue of elements to process */
    this.processingQueue = new Set();

    /** @type {number|null} Debounce timer reference */
    this.debounceTimer = null;

    /** @type {boolean} Whether observer is paused */
    this.paused = false;
  }

  /**
   * Start observing the DOM for new tweets
   * Retries if main content element is not found
   */
  start() {
    const mainContent = document.querySelector('main[role="main"]');
    if (!mainContent) {
      setTimeout(() => this.start(), 500);
      return;
    }

    this.observer = new MutationObserver((mutations) => {
      this.onMutation(mutations);
    });

    this.observer.observe(mainContent, {
      childList: true,
      subtree: true
    });

    this.processVisibleTweets();
  }

  /**
   * Stop observing and disconnect the MutationObserver
   */
  stop() {
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
  }

  /**
   * Pause the observer (stops processing but keeps observing)
   */
  pause() {
    this.paused = true;
  }

  /**
   * Resume the observer and process visible tweets
   */
  resume() {
    this.paused = false;
    this.processVisibleTweetsResume();
  }

  /**
   * Handle DOM mutations - add new tweets to processing queue
   * @param {MutationRecord[]} mutations - Array of mutation records
   * @private
   */
  onMutation(mutations) {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;

        if (node.matches?.('article[data-testid="tweet"], [data-testid="UserCell"]')) {
          this.processingQueue.add(node);
        }
        else if (node.querySelectorAll) {
          const tweets = node.querySelectorAll('article[data-testid="tweet"], [data-testid="UserCell"]');
          tweets.forEach(tweet => this.processingQueue.add(tweet));
        }
      }
    }

    if (this.processingQueue.size > 0) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(() => {
        this.processQueue();
      }, 300);
    }
  }

  /**
   * Process all queued tweets
   * @private
   */
  processQueue() {
    if (this.paused) {
      this.processingQueue.clear();
      return;
    }

    const tweets = Array.from(this.processingQueue);
    this.processingQueue.clear();

    for (const tweet of tweets) {
      this.processTweet(tweet);
    }
  }

  /**
   * Process a single tweet element
   * Extracts username, checks cache, and either renders flag or queues fetch
   * @param {HTMLElement} tweetElement - Tweet or UserCell element
   * @private
   */
  processTweet(tweetElement) {
    if (this.paused) return;

    const username = this.extractUsername(tweetElement);
    if (!username) return;

    const existingFlag = tweetElement.querySelector('[data-xflag]');
    if (existingFlag) return;

    // Register element for O(1) lookup later
    if (window.xflagRegisterElement) {
      window.xflagRegisterElement(username, tweetElement);
    }

    window.xflagRenderer.renderLoadingFlag(tweetElement, username);

    if (window.xflagCache.has(username)) {
      const countryData = window.xflagCache.get(username);
      window.xflagRenderer.renderFlag(tweetElement, username, countryData);
    } else {
      if (window.xflagFetcher && !window.xflagFetcher.isRateLimited()) {
        // Pass element reference for viewport-first priority queue
        window.xflagFetcher.fetchUserLocation(username, tweetElement);
      }
    }
  }

  /**
   * Extract username from tweet/user cell element
   * @param {HTMLElement} element - Tweet or UserCell element
   * @returns {string|null} Username without @ prefix, or null if not found
   */
  extractUsername(element) {
    const userNameContainer = element.querySelector('[data-testid="UserName"], [data-testid="User-Name"]');
    if (!userNameContainer) return null;

    const links = userNameContainer.querySelectorAll('a[href^="/"]');
    for (const link of links) {
      const href = link.getAttribute('href');
      const match = href.match(/^\/([^\/\?]+)/);

      if (match && match[1]) {
        const username = match[1];
        // Exclude X's reserved routes
        const excludedRoutes = ['home', 'explore', 'notifications', 'messages', 'i', 'compose', 'search', 'settings'];
        if (!excludedRoutes.includes(username) && username.length > 0 && username.length < 20) {
          return username;
        }
      }
    }

    return null;
  }

  /**
   * Process all currently visible tweets on the page
   * Called on initial load
   * @private
   */
  processVisibleTweets() {
    const tweets = document.querySelectorAll('article[data-testid="tweet"], [data-testid="UserCell"]');
    tweets.forEach(tweet => this.processTweet(tweet));
  }

  /**
   * Process visible tweets that don't already have flags
   * Called when resuming after being paused
   * @private
   */
  processVisibleTweetsResume() {
    const tweets = document.querySelectorAll('article[data-testid="tweet"], [data-testid="UserCell"]');

    tweets.forEach(tweet => {
      const existingFlag = tweet.querySelector('[data-xflag]');
      if (!existingFlag) {
        this.processTweet(tweet);
      }
    });
  }
}

if (typeof window !== 'undefined') {
  window.xflagObserver = new TweetObserver();
}
