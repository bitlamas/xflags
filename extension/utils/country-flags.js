// country name to PNG flag filename mapping

// special case mappings where X API name differs from our filename
const COUNTRY_NAME_MAPPINGS = {
  "Korea": "south-korea",
  "Czech Republic": "czechia",
  "United Kingdom": "united-kingdom",
  "UK": "united-kingdom",
  "USA": "united-states",
  "US": "united-states",
  "UAE": "united-arab-emirates",
  "Hong Kong": "hong-kong",
  "Vatican": "vatican-city",
  "DR Congo": "dr-congo",
  "DRC": "dr-congo",
  "CAR": "car",
  "Ivory Coast": "cote-d'ivoire",
  "Sint Maarten": "sint-maarten",
  "St. Lucia": "saint-lucia",
  "Saint Lucia": "saint-lucia",
  // special case for no location data
  "undefined": "undefined",
  // regions - based on actual X API responses
  "Australasia": "regional",
  "West Asia": "regional",
  "East Asia": "regional",
  "East Asia & Pacific": "regional",
  "Asia": "regional",
  "Southeast Asia": "regional",
  "South Asia": "regional",
  "Central Asia": "regional",
  "Eastern Europe": "regional",
  "Western Europe": "regional",
  "Southern Europe": "regional",
  "Northern Europe": "regional",
  "Africa": "regional",
  "North Africa": "regional",
  "East Africa": "regional",
  "West Africa": "regional",
  "Central Africa": "regional",
  "South America": "regional",
  "Central America": "regional",
  "Middle East": "regional",
  "Oceania": "regional",
  "Caribbean": "regional",
  "Balkans": "regional",
  "Scandinavia": "regional",
  "North America": "north-america"
};

/**
 * Get PNG flag filename for a country name
 * @param {string} countryName - Country name from X API (e.g., "United States", "Korea")
 * @returns {string|null} - Filename without extension (e.g., "united-states") or null if not found
 */
function getCountryFlagFilename(countryName) {
  if (!countryName || typeof countryName !== 'string') {
    return null;
  }

  const trimmed = countryName.trim();
  if (!trimmed) {
    return null;
  }

  if (COUNTRY_NAME_MAPPINGS[trimmed]) {
    return COUNTRY_NAME_MAPPINGS[trimmed];
  }

  const filename = trimmed
    .toLowerCase()
    .replace(/\s+/g, '-')           // Replace spaces with hyphens
    .replace(/[()]/g, '')           // Remove parentheses
    .replace(/,/g, '')              // Remove commas
    .replace(/\./g, '')             // Remove periods
    .replace(/'/g, '')              // Remove apostrophes
    .replace(/--+/g, '-')           // Replace multiple hyphens with single
    .replace(/^-|-$/g, '');         // Remove leading/trailing hyphens

  return filename;
}

/**
 * Get full PNG flag image URL for a country
 * @param {string} countryName - Country name from X API
 * @returns {string} - Full URL to PNG flag image (falls back to regional.png)
 */
function getCountryFlagURL(countryName) {
  const browser = window.xflagBrowser;
  if (!browser || !browser.runtime || !browser.runtime.getURL) {
    console.error('[xflags] Browser runtime API not available');
    return null;
  }

  const filename = getCountryFlagFilename(countryName);

  if (!filename) {
    console.log(`[xflags] No flag mapping for "${countryName}", using regional fallback`);
    return browser.runtime.getURL('icons/flags/regional.png');
  }

  return browser.runtime.getURL(`icons/flags/${filename}.png`);
}

/**
 * Check if we have a flag for a country
 * @param {string} countryName - Country name from X API
 * @returns {boolean}
 */
function hasCountryFlag(countryName) {
  const filename = getCountryFlagFilename(countryName);
  return filename !== null && filename.length > 0;
}

if (typeof window !== 'undefined') {
  window.getCountryFlagFilename = getCountryFlagFilename;
  window.getCountryFlagURL = getCountryFlagURL;
  window.hasCountryFlag = hasCountryFlag;
}
