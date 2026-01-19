// api interceptor - runs in page context to observe X's responses
//
// IMPORTANT: This file runs in PAGE CONTEXT, not extension context.
// It is injected as a <script> tag and executes within X's JavaScript environment.
//
// WHY FUNCTIONS ARE DUPLICATED FROM api-data-extractor.js:
// - This interceptor runs in PAGE context (window scope of x.com)
// - api-data-extractor.js runs in EXTENSION context (content script)
// - Page context CANNOT import modules or access extension APIs
// - Extension context CANNOT intercept page's XHR/fetch calls
// - Therefore, we must duplicate: getNestedValue, extractCountryData, extractScreenName, isRelevantAPICall
//
// The duplication is intentional and necessary for the architecture to work.

(function() {
  // Headers stored in closure - not exposed globally or via postMessage unnecessarily
  // This minimizes the exposure of sensitive auth tokens
  let capturedHeaders = null;
  let headersSentToExtension = false;

  /**
   * Capture auth headers from X's API requests
   * Headers are stored in closure and only sent to extension context once
   * @param {Object|Headers} headers - Request headers
   */
  function captureHeaders(headers) {
    if (!headers) {
      return;
    }

    // handle both Headers object and plain object
    const getHeader = (key) => {
      if (typeof headers.get === 'function') {
        return headers.get(key);
      }
      return headers[key];
    };

    const newHeaders = {
      'authorization': getHeader('authorization'),
      'x-csrf-token': getHeader('x-csrf-token'),
      'x-twitter-auth-type': getHeader('x-twitter-auth-type'),
      'x-twitter-active-user': getHeader('x-twitter-active-user'),
      'x-twitter-client-language': getHeader('x-twitter-client-language')
    };

    // Remove undefined/null values
    Object.keys(newHeaders).forEach(key => {
      if (!newHeaders[key]) delete newHeaders[key];
    });

    // Only update and send if we have valid headers
    if (Object.keys(newHeaders).length > 0 && newHeaders.authorization) {
      capturedHeaders = newHeaders;

      // Send headers to extension context only once (or when they change)
      // This minimizes exposure of sensitive data via postMessage
      if (!headersSentToExtension) {
        headersSentToExtension = true;
        // Security: Use specific origin instead of '*' to prevent cross-origin message interception
        window.postMessage({
          type: 'XFLAG_HEADERS_CAPTURED',
          headers: capturedHeaders
        }, window.location.origin);
      }
    }
  }

  /**
   * Safely get nested value from object using dot notation path
   * @param {Object} obj - Source object
   * @param {string} path - Dot-separated path (e.g., 'data.user.name')
   * @returns {*} Value at path or undefined
   */
  function getNestedValue(obj, path) {
    const keys = path.split('.');
    let current = obj;
    for (const key of keys) {
      if (current && typeof current === 'object' && key in current) {
        current = current[key];
      } else {
        return undefined;
      }
    }
    return current;
  }

  /**
   * Extract country data from API response (recursive search for all users)
   * Uses WeakSet to prevent infinite loops from circular references
   * Uses Object.keys() instead of for...in to avoid inherited properties
   * @param {Object} apiResponse - Parsed JSON response from X API
   * @returns {Array<{screenName: string, location: string, accurate: boolean}>}
   */
  function extractCountryData(apiResponse) {
    // WeakSet to track visited objects and prevent circular reference issues
    const visited = new WeakSet();

    /**
     * Recursively find user location data in nested objects
     * @param {*} obj - Current object to examine
     * @param {number} depth - Current recursion depth
     * @returns {Array} Array of user location objects
     */
    function findUserLocations(obj, depth = 0) {
      // Prevent excessive recursion
      if (depth > 25) return [];

      // Skip non-objects and primitives
      if (!obj || typeof obj !== 'object') return [];

      // Prevent circular reference infinite loops
      if (visited.has(obj)) return [];
      visited.add(obj);

      const foundUsers = [];

      // Pattern 1: screen_name and location at same level (rare)
      if (obj.screen_name && typeof obj.screen_name === 'string') {
        let location = null;
        let accurate = true;

        if (obj.account_based_in && typeof obj.account_based_in === 'string') {
          location = obj.account_based_in;
          accurate = obj.location_accurate !== false;
        }
        else if (obj.location && typeof obj.location === 'string' && obj.location.trim()) {
          location = obj.location;
          accurate = true;
        }

        if (location) {
          foundUsers.push({
            screenName: obj.screen_name,
            location: location,
            accurate: accurate
          });
        }
      }

      // Pattern 2: obj.legacy.screen_name with obj.location as sibling (X's actual structure!)
      if (obj.legacy && obj.legacy.screen_name && typeof obj.legacy.screen_name === 'string') {
        let location = null;
        let accurate = true;

        if (obj.location && typeof obj.location === 'string' && obj.location.trim()) {
          location = obj.location;
          accurate = true;
        }
        else if (obj.legacy.location && typeof obj.legacy.location === 'string' && obj.legacy.location.trim()) {
          location = obj.legacy.location;
          accurate = true;
        }

        if (location) {
          foundUsers.push({
            screenName: obj.legacy.screen_name,
            location: location,
            accurate: accurate
          });
        }
      }

      // Recursively search child properties
      // Use Object.keys() instead of for...in to avoid inherited properties
      const keys = Object.keys(obj);
      for (const key of keys) {
        const value = obj[key];
        if (Array.isArray(value)) {
          for (const item of value) {
            foundUsers.push(...findUserLocations(item, depth + 1));
          }
        } else if (typeof value === 'object' && value !== null) {
          foundUsers.push(...findUserLocations(value, depth + 1));
        }
      }

      return foundUsers;
    }

    return findUserLocations(apiResponse);
  }

  /**
   * Extract screen name from URL or API response
   * @param {string} url - Request URL
   * @param {Object} apiResponse - Parsed JSON response
   * @returns {string|null} Screen name or null
   */
  function extractScreenName(url, apiResponse) {
    const urlMatch = url.match(/screenName[=:]"?([^"&]+)"?/);
    if (urlMatch) return urlMatch[1];

    try {
      const urlObj = new URL(url);
      const variables = urlObj.searchParams.get('variables');
      if (variables) {
        const parsed = JSON.parse(variables);
        if (parsed.screenName) return parsed.screenName;
        if (parsed.screen_name) return parsed.screen_name;
      }
    } catch (e) {
      // URL parsing failed, continue to fallback
    }

    const paths = [
      'data.user_result_by_screen_name.result.legacy.screen_name',
      'data.user.result.legacy.screen_name',
      'data.user.legacy.screen_name',
      'data.user.screen_name'
    ];

    for (const path of paths) {
      const screenName = getNestedValue(apiResponse, path);
      if (screenName && typeof screenName === 'string') {
        return screenName;
      }
    }

    return null;
  }

  /**
   * Check if URL is a relevant API endpoint for location data
   * @param {string} url - Request URL
   * @returns {boolean} True if relevant
   */
  function isRelevantAPICall(url) {
    const relevantEndpoints = [
      'UserByScreenName',
      'AboutAccountQuery',
      'ProfileSpotlightsQuery',
      'UserTweets',
      'UserByRestId',
      'ProfileSpotlights'
    ];

    return relevantEndpoints.some(endpoint => url.includes(endpoint));
  }

  // intercept fetch - use defineProperty to prevent X from overwriting it
  const originalFetch = window.fetch;
  const interceptedFetch = async function(...args) {
    const url = typeof args[0] === 'string' ? args[0] : args[0]?.url;

    // capture headers from X's graphql api calls (though X uses XHR, not fetch)
    if (url && url.includes('x.com/i/api/graphql')) {
      // handle both fetch(url, options) and fetch(Request)
      let headers = null;
      if (typeof args[0] === 'string' && args[1]) {
        headers = args[1].headers;
      } else if (args[0]?.headers) {
        headers = args[0].headers;
      }

      if (headers) {
        captureHeaders(headers);
      }
    }

    const response = await originalFetch.apply(this, args);

    if (url && url.includes('x.com/i/api/') && isRelevantAPICall(url)) {
      try {
        const clonedResponse = response.clone();
        const data = await clonedResponse.json();

        const countryData = extractCountryData(data);
        if (countryData) {
          const screenName = extractScreenName(url, data);

          if (screenName) {
            // Security: Use specific origin instead of '*'
            window.postMessage({
              type: 'XFLAG_COUNTRY_DATA',
              screenName: screenName,
              location: countryData.location,
              accurate: countryData.accurate,
              source: countryData.source
            }, window.location.origin);
          }
        }
      } catch (e) {
        // response not json or parsing failed - ignore
      }
    }

    return response;
  };

  // make fetch non-configurable to prevent X from overwriting our interceptor
  try {
    Object.defineProperty(window, 'fetch', {
      value: interceptedFetch,
      writable: false,
      configurable: false
    });
  } catch (e) {
    // if defineProperty fails, fall back to normal assignment
    window.fetch = interceptedFetch;
  }

  // intercept XMLHttpRequest - X uses XHR for GraphQL, not fetch!
  const originalXHROpen = XMLHttpRequest.prototype.open;
  const originalXHRSend = XMLHttpRequest.prototype.send;
  const originalXHRSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;

  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    this._xflagURL = url;
    this._xflagHeaders = {};

    return originalXHROpen.apply(this, [method, url, ...rest]);
  };

  XMLHttpRequest.prototype.setRequestHeader = function(header, value) {
    if (this._xflagHeaders) {
      this._xflagHeaders[header.toLowerCase()] = value;
    }

    return originalXHRSetRequestHeader.apply(this, [header, value]);
  };

  const captureHeadersFromXHR = function() {
    if (this._xflagURL && this._xflagURL.includes('x.com/i/api/graphql')) {
      if (!this._xflagHeadersLogged) {
        this._xflagHeadersLogged = true;

        if (!capturedHeaders || Object.keys(capturedHeaders).length < 3) {
          captureHeaders(this._xflagHeaders);
        }
      }
    }
  };

  XMLHttpRequest.prototype.send = function(...args) {
    captureHeadersFromXHR.call(this);

    // intercept all graphql responses to extract user location data
    if (this._xflagURL && this._xflagURL.includes('x.com/i/api/graphql')) {
      this.addEventListener('load', function() {
        try {
          const data = JSON.parse(this.responseText);
          const usersWithLocation = extractCountryData(data);

          usersWithLocation.forEach(({screenName, location, accurate}) => {
            // Security: Use specific origin instead of '*'
            window.postMessage({
              type: 'XFLAG_COUNTRY_DATA',
              screenName,
              location,
              accurate
            }, window.location.origin);
          });
        } catch (e) {
          console.error('[xflags] Error in XHR load handler:', e);
        }
      });
    }

    return originalXHRSend.apply(this, args);
  };
})();
