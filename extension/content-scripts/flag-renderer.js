// flag renderer - inserts before display name

/**
 * FlagRenderer - Renders country flags next to X usernames
 *
 * Handles:
 * - Display name detection (including emoji-only names)
 * - Fullwidth @ character support (East Asian typography)
 * - Loading state indicators with animated dots
 * - WeakMap/WeakSet for memory efficiency
 * - VPN/inaccurate location detection
 *
 * @class
 */
class FlagRenderer {
  constructor() {
    this.processedElements = new WeakSet();
    this.loadingElements = new WeakMap();
  }

  /**
   * Render loading indicator for a username
   * Shows animated loading dots while fetching location data
   * @param {HTMLElement} container - Tweet or UserCell container element
   * @param {string} screenName - X username (without @)
   * @returns {boolean} True if loading flag was rendered successfully
   */
  renderLoadingFlag(container, screenName) {
    // skip if already has a flag (loading or actual)
    const displayNameElement = this.findDisplayName(container, screenName);
    if (!displayNameElement) {
      return false;
    }

    const existingFlag = displayNameElement.parentNode?.querySelector('[data-xflag]');
    if (existingFlag) {
      return false;
    }

    const loadingFlag = this.createLoadingFlagElement();

    try {
      displayNameElement.parentNode.insertBefore(loadingFlag, displayNameElement);
      this.loadingElements.set(container, loadingFlag);
      return true;
    } catch (error) {
      console.error('[xflags] Error inserting loading flag:', error);
      return false;
    }
  }

  /**
   * Render country flag for a username
   * Replaces loading indicator with actual flag image
   * @param {HTMLElement} container - Tweet or UserCell container element
   * @param {string} screenName - X username (without @)
   * @param {Object} countryData - Location data
   * @param {string} countryData.location - Country/region name
   * @param {boolean} countryData.accurate - Whether location is accurate (false for VPN)
   * @returns {Promise<boolean>} True if flag was rendered successfully
   */
  async renderFlag(container, screenName, countryData) {
    // skip if already processed with actual flag
    if (this.processedElements.has(container)) {
      return false;
    }

    this.processedElements.add(container);

    const displayNameElement = this.findDisplayName(container, screenName);
    if (!displayNameElement) {
      return false;
    }

    // check if loading flag exists - we'll replace it
    const existingFlag = displayNameElement.parentNode?.querySelector('[data-xflag]');
    const isLoadingFlag = existingFlag && existingFlag.getAttribute('data-loading') === 'true';

    // if it's not a loading flag and a flag exists, skip
    if (existingFlag && !isLoadingFlag) {
      return false;
    }

    const flagURL = getCountryFlagURL(countryData.location);
    if (!flagURL) {
      console.log(`[xflags] No flag image for: ${countryData.location}`);
      return false;
    }

    const flag = this.createFlagElement(flagURL, countryData);

    try {
      if (isLoadingFlag && existingFlag) {
        existingFlag.replaceWith(flag);
        console.log(`[xflags] ✓ Updated flag for @${screenName} (${countryData.location})`);
      } else {
        displayNameElement.parentNode.insertBefore(flag, displayNameElement);
        console.log(`[xflags] ✓ Added flag for @${screenName} (${countryData.location})`);
      }

      this.loadingElements.delete(container);

      return true;
    } catch (error) {
      console.error('[xflags] Error inserting flag:', error);
      return false;
    }
  }

  createLoadingFlagElement() {
    const container = document.createElement('span');
    container.className = 'xflag-country';
    container.setAttribute('data-xflag', 'true');
    container.setAttribute('data-loading', 'true');
    container.setAttribute('role', 'status');
    container.setAttribute('aria-label', 'Loading');

    // rectangle loader with 12 dots
    const loadingBox = document.createElement('div');
    loadingBox.className = 'xflag-loading-box';
    loadingBox.title = 'Loading, please wait';

    for (let i = 0; i < 12; i++) {
      const dot = document.createElement('span');
      dot.className = 'xflag-dot';
      loadingBox.appendChild(dot);
    }

    container.appendChild(loadingBox);

    return container;
  }

  /**
   * Find display name element for a user
   * Handles edge cases: emoji-only names, fullwidth @ character, display name = handle
   * @param {HTMLElement} container - Tweet or UserCell container element
   * @param {string} screenName - X username (without @)
   * @returns {HTMLElement|null} Display name element or null if not found
   * @private
   */
  findDisplayName(container, screenName) {
    // username container has both display name and @username
    const userNameContainer = container.querySelector('[data-testid="UserName"], [data-testid="User-Name"]');
    if (!userNameContainer) {
      return null;
    }

    const links = userNameContainer.querySelectorAll('a[href^="/"]');
    let handleLink = null; // fallback if no separate display name

    for (const link of links) {
      const href = link.getAttribute('href');
      const text = link.textContent?.trim();

      if (href === `/${screenName}` || href.startsWith(`/${screenName}?`)) {
        // Check for fullwidth @ (＠ U+FF20) used in East Asian typography
        // Display names can contain fullwidth @, but not ASCII @ (U+0040)
        // Some users set display name to "@username" or "＠username"
        // Note: Display name can be same as screenName OR be empty for emoji-only names
        if (text !== undefined && !text.startsWith('@')) {
          const displaySpan = link.querySelector('span');
          if (displaySpan) {
            return displaySpan;
          }
          return link;
        } else if ((text === `@${screenName}` || text === `＠${screenName}`) && !handleLink) {
          // save FIRST handle link as fallback (for users whose display name equals their handle)
          // don't overwrite if we already found one (keep first occurrence = display name position)
          handleLink = link;
        }
      }
    }

    // fallback: if display name not found, use handle link (happens when display name = @username)
    if (handleLink) {
      const displaySpan = handleLink.querySelector('span');
      if (displaySpan) {
        return displaySpan;
      }
      return handleLink;
    }

    return null;
  }

  findHandleLink(container, screenName) {
    const links = container.querySelectorAll('a[href^="/"]');

    for (const link of links) {
      const text = link.textContent?.trim();
      const href = link.getAttribute('href');

      // check for both regular @ (U+0040) and fullwidth @ (U+FF20)
      if ((text === `@${screenName}` || text === `＠${screenName}` || text === screenName) &&
          (href === `/${screenName}` || href.startsWith(`/${screenName}?`))) {
        return link;
      }
    }

    // fallback: find any link to the user's profile that looks like a handle
    for (const link of links) {
      const href = link.getAttribute('href');
      if ((href === `/${screenName}` || href.startsWith(`/${screenName}?`)) &&
          (link.textContent?.includes('@') || link.textContent?.includes('＠'))) {
        return link;
      }
    }

    return null;
  }

  createFlagElement(flagURL, countryData) {
    const container = document.createElement('span');
    container.className = 'xflag-country';
    container.setAttribute('data-xflag', 'true');
    container.setAttribute('data-country', countryData.location);
    container.setAttribute('data-accurate', countryData.accurate ? 'true' : 'false');

    const isUndefined = countryData.location === 'undefined';

    // add VPN indicator text if inaccurate AND not undefined
    if (!countryData.accurate && !isUndefined) {
      const vpnIndicator = document.createElement('span');
      vpnIndicator.className = 'xflag-vpn-indicator';
      vpnIndicator.textContent = 'VPN?';
      vpnIndicator.title = 'Location may be inaccurate (VPN detected)';
      container.appendChild(vpnIndicator);
    }

    const flagImg = document.createElement('img');
    flagImg.src = flagURL;
    flagImg.className = 'xflag-flag-img';
    flagImg.alt = countryData.location;

    if (isUndefined) {
      flagImg.title = 'Location data not available';
    } else {
      flagImg.title = countryData.location;
    }

    flagImg.onerror = () => {
      const regionalURL = getCountryFlagURL('regional-fallback-internal');
      if (regionalURL && flagImg.src !== regionalURL) {
        console.log(`[xflags] Flag not found for "${countryData.location}", using regional fallback`);
        flagImg.src = window.xflagBrowser.runtime.getURL('icons/flags/regional.png');
      }
    };

    container.appendChild(flagImg);

    return container;
  }

  hideAllFlags() {
    const flags = document.querySelectorAll('[data-xflag]');
    flags.forEach(flag => flag.style.display = 'none');
    console.log(`[xflags] Hidden ${flags.length} flags`);
  }

  showAllFlags() {
    const flags = document.querySelectorAll('[data-xflag]');
    flags.forEach(flag => flag.style.display = '');
    console.log(`[xflags] Shown ${flags.length} flags`);
  }

  removeAllFlags() {
    const flags = document.querySelectorAll('[data-xflag]');
    flags.forEach(flag => flag.remove());
    console.log(`[xflags] Removed ${flags.length} flags`);
  }
}

if (typeof window !== 'undefined') {
  window.xflagRenderer = new FlagRenderer();
}
