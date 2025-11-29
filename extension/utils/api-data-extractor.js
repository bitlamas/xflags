// multi-path api data extractor - resilient to api structure changes

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

function extractCountryData(apiResponse) {
  // try multiple possible paths (resilient to API changes)
  const paths = [
    'data.user_result_by_screen_name.result.about_profile',
    'data.user.result.about_profile',
    'data.user.about_profile',
    'data.user_result_by_screen_name.result.legacy',
    'data.user.result.legacy',
    'data.user.legacy'
  ];

  for (const path of paths) {
    const obj = getNestedValue(apiResponse, path);

    if (obj?.account_based_in) {
      return {
        location: obj.account_based_in,
        accurate: obj.location_accurate !== false,
        source: obj.source || null
      };
    }

    if (obj?.location && typeof obj.location === 'string') {
      return {
        location: obj.location,
        accurate: true,
        source: null
      };
    }
  }

  return null;
}

function extractScreenName(url, apiResponse) {
  const urlMatch = url.match(/screenName[=:]"?([^"&]+)"?/);
  if (urlMatch) {
    return urlMatch[1];
  }

  try {
    const urlObj = new URL(url);
    const variables = urlObj.searchParams.get('variables');
    if (variables) {
      const parsed = JSON.parse(variables);
      if (parsed.screenName) {
        return parsed.screenName;
      }
    }
  } catch (e) {
    // url parsing failed, continue
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

function isRelevantAPICall(url) {
  const relevantEndpoints = [
    'UserByScreenName',
    'AboutAccountQuery',
    'ProfileSpotlightsQuery',
    'UserTweets',
    'UserByRestId'
  ];

  return relevantEndpoints.some(endpoint => url.includes(endpoint));
}

if (typeof window !== 'undefined') {
  window.xflagExtractor = {
    extractCountryData,
    extractScreenName,
    isRelevantAPICall
  };
}
