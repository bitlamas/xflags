<img src="./extension/icons/icon96.png" alt="xflags logo" width="64" align="left">

# xflags

<br clear="left"/>

This extension uses the country location now publicly available on X to add a country flag in the same style found on 4chan's /int/ and /pol/ boards. [View screenshot](./screenshot.jpg).

It uses X's internal API `AboutAccountQuery` GraphQL endpoint to retrieve user location data, then cache that for 30 days (configurable) to minimize API usage and avoid rate limiting. It uses smart caching to avoid redundant API calls, request queuing to process usernames sequentially and has a 5-minute cooldown after receiving a rate limit 429 error.

No data collection. All local.

## hic sunt dracones

Even though i'm very conservative making requests at 5s intervals, imposing cooldowns if we get a rate limit error, etc, there's always the chance X doesn't like you using their internal API for this purpose, so let me just remember that you'll be using this at your own risk. I've been developing and testing with my own account and nothing happened so far :-)

## Features

- 4chan's PNG country flags next to usernames
- Display VPN indicator for accounts with inaccurate location data
- Has as built-in console tab to track fetches, rate limiting status, etc

### Regional flags

X's API sometimes does not return a country but a region, like "North America" or "East Asia & Pacific". These are treated differently, e.g. Europe is shown as EU flag, while West Asia may show just a standard globe icon.

## Installation

### Firefox

1. download or clone this repository:
   ```bash
   git clone https://github.com/bitlamas/xflags.git
   cd xflags
   ```

2. open Firefox and navigate to `about:debugging#/runtime/this-firefox`

3. click "Load Temporary Add-on"

4. navigate to the `extension` folder and select `manifest.json`

### Chrome/Chromium

1. download or clone this repository:
   ```bash
   git clone https://github.com/bitlamas/xflags.git
   cd xflags
   ```

2. open Chrome and navigate to `chrome://extensions/`

3. enable "Developer mode" in the top right

4. click "Load unpacked"

5. select the `extension` folder

## Known issues
- Sometimes an account may get stuck with the loading icon, but if you keep scrolling it will eventually fetch it
- If you're a power user you'll hit the fetch limit, guaranteed: you need to be patient as X imposes rate limits, so if you're a power user you'll often hit the limit. Soon enough, though, you will have a sizeable local cache for many repeating accounts and it will minimize the API calls.

## About

- Manifest V3
- Vanilla JavaScript
- Browser's local storage API for caching

This software is GPLv3+; included 4chan PNG flags are not licensed under the GPL.
