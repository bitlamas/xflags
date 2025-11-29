// api interceptor - runs in page context to observe X's responses

(function() {
  let capturedHeaders = null;

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

    capturedHeaders = {
      'authorization': getHeader('authorization'),
      'x-csrf-token': getHeader('x-csrf-token'),
      'x-twitter-auth-type': getHeader('x-twitter-auth-type'),
      'x-twitter-active-user': getHeader('x-twitter-active-user'),
      'x-twitter-client-language': getHeader('x-twitter-client-language')
    };

    Object.keys(capturedHeaders).forEach(key => {
      if (!capturedHeaders[key]) delete capturedHeaders[key];
    });

    if (Object.keys(capturedHeaders).length > 0) {
      window.postMessage({
        type: 'XFLAG_HEADERS_CAPTURED',
        headers: capturedHeaders
      }, '*');
    }
  }

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

  // extract country data from api response (recursive search for all users)
  function extractCountryData(apiResponse) {
    let maxDepthReached = 0;
    let objectsExamined = 0;
    let screenNameFoundCount = 0;
    let locationFoundCount = 0;

    function findUserLocations(obj, depth = 0) {
      if (depth > maxDepthReached) maxDepthReached = depth;
      if (depth > 25) return []; // prevent excessive recursion

      if (!obj || typeof obj !== 'object') return [];

      objectsExamined++;
      let foundUsers = [];

      // pattern 1: screen_name and location at same level (rare)
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

      // pattern 2: obj.legacy.screen_name with obj.location as sibling (X's actual structure!)
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

      for (const key in obj) {
        if (Array.isArray(obj[key])) {
          obj[key].forEach(item => {
            foundUsers.push(...findUserLocations(item, depth + 1));
          });
        } else if (typeof obj[key] === 'object' && obj[key] !== null) {
          foundUsers.push(...findUserLocations(obj[key], depth + 1));
        }
      }

      return foundUsers;
    }

    const allUsers = findUserLocations(apiResponse);
    return allUsers;
  }

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
    } catch (e) {}

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
            window.postMessage({
              type: 'XFLAG_COUNTRY_DATA',
              screenName: screenName,
              location: countryData.location,
              accurate: countryData.accurate,
              source: countryData.source
            }, '*');
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
            window.postMessage({
              type: 'XFLAG_COUNTRY_DATA',
              screenName,
              location,
              accurate
            }, '*');
          });
        } catch (e) {
          console.error('[xflags] ❌ Error in XHR load handler:', e);
        }
      });
    }

    return originalXHRSend.apply(this, args);
  };
})();
