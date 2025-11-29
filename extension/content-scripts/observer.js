// mutation observer for detecting new tweets

class TweetObserver {
  constructor() {
    this.observer = null;
    this.processingQueue = new Set();
    this.debounceTimer = null;
    this.paused = false;
  }

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

  stop() {
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
  }

  pause() {
    this.paused = true;
  }

  resume() {
    this.paused = false;
    this.processVisibleTweetsResume();
  }

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

  processTweet(tweetElement) {
    if (this.paused) return;
    const username = this.extractUsername(tweetElement);
    if (!username) return;

    const existingFlag = tweetElement.querySelector('[data-xflag]');
    if (existingFlag) return;
    window.xflagRenderer.renderLoadingFlag(tweetElement, username);

    if (window.xflagCache.has(username)) {
      const countryData = window.xflagCache.get(username);
      window.xflagRenderer.renderFlag(tweetElement, username, countryData);
    } else {
      if (window.xflagFetcher && !window.xflagFetcher.isRateLimited()) {
        window.xflagFetcher.fetchUserLocation(username);
      }
    }
  }

  extractUsername(element) {
    const userNameContainer = element.querySelector('[data-testid="UserName"], [data-testid="User-Name"]');
    if (!userNameContainer) return null;

    const links = userNameContainer.querySelectorAll('a[href^="/"]');
    for (const link of links) {
      const href = link.getAttribute('href');
      const match = href.match(/^\/([^\/\?]+)/);

      if (match && match[1]) {
        const username = match[1];
        const excludedRoutes = ['home', 'explore', 'notifications', 'messages', 'i', 'compose', 'search', 'settings'];
        if (!excludedRoutes.includes(username) && username.length > 0 && username.length < 20) {
          return username;
        }
      }
    }

    return null;
  }

  processVisibleTweets() {
    const tweets = document.querySelectorAll('article[data-testid="tweet"], [data-testid="UserCell"]');
    tweets.forEach(tweet => this.processTweet(tweet));
  }

  // only process tweets without existing flags
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
