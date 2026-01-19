<img src="./extension/icons/icon96.png" alt="xflags logo" width="64" align="left">

# xflags

<br clear="left"/>

A Firefox and Chrome extension that displays country flags next to X (Twitter) usernames, using the same 4chan /int/ and /pol/ style flags. [View screenshot](./screenshot.jpg).

No data collection. All local.

## Features

- 4chan PNG country flags next to usernames
- VPN indicator for accounts with inaccurate location data
- Built-in console tab to track fetches and rate limiting status
- Configurable cache TTL (1-365 days, default 30 days)
- Cross-tab request deduplication
- Viewport-priority fetching (visible users fetched first)
- Opt-in error logging with local export

### Regional Flags

X's API sometimes returns a region instead of a country (e.g., "North America", "East Asia & Pacific"). These display as regional icons—Europe shows the EU flag, while broader regions show a globe icon.

## Installation

### Firefox

1. Clone this repository:
   ```bash
   git clone https://github.com/bitlamas/xflags.git
   ```

2. Navigate to `about:debugging#/runtime/this-firefox`

3. Click "Load Temporary Add-on" and select `extension/manifest.json`

### Chrome/Chromium

1. Clone this repository:
   ```bash
   git clone https://github.com/bitlamas/xflags.git
   ```

2. Navigate to `chrome://extensions/`

3. Enable "Developer mode" (top right)

4. Click "Load unpacked" and select the `extension` folder

## How It Works

xflags intercepts X's GraphQL API responses to extract user location data, then renders country flags in the DOM.

### Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Service Worker                           │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────────────────┐  │
│  │ UnifiedCache│  │ Deduplicator │  │ RateLimitCoordinator  │  │
│  └─────────────┘  └──────────────┘  └───────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                              ▲
                              │ chrome.runtime.sendMessage
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Content Scripts                            │
│  ┌────────────┐  ┌──────────┐  ┌─────────────┐  ┌───────────┐  │
│  │ interceptor│  │ observer │  │ active-fetch│  │ renderer  │  │
│  │ (page ctx) │  │ (DOM)    │  │ (API queue) │  │ (flags)   │  │
│  └────────────┘  └──────────┘  └─────────────┘  └───────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### Data Flow

1. **Interception** — `interceptor.js` runs in page context, monkey-patches `fetch`/`XMLHttpRequest` to capture auth headers and extract location data from `AboutAccountQuery` responses

2. **Observation** — `observer.js` uses MutationObserver to detect new tweets in the DOM

3. **Cache Check** — For each username, the service worker's unified cache is queried

4. **Fetching** — On cache miss, `active-fetcher.js` queues the request with viewport-based priority (visible users first)

5. **Rendering** — `flag-renderer.js` inserts the flag element next to the username

### Cross-Context Communication

The extension operates across three contexts:

| Context | Scripts | Communication |
|---------|---------|---------------|
| **Page** | `interceptor.js` | `postMessage` to content script |
| **Content** | `main.js`, `observer.js`, etc. | `chrome.runtime.sendMessage` to service worker |
| **Background** | `service-worker.js` | Handles messages from all tabs |

The interceptor must run in page context to access X's fetch responses, but cannot directly communicate with the service worker—hence the postMessage bridge through content scripts.

### Rate Limiting

- 5-second minimum interval between API requests
- 5-minute cooldown after receiving HTTP 429
- Coordinated across all tabs via service worker
- Viewport-priority queue ensures visible users are fetched first

## Project Structure

```
extension/
├── manifest.json
├── background/
│   └── service-worker.js    # Central coordinator
├── content-scripts/
│   ├── main.js              # Entry point, message routing
│   ├── interceptor.js       # Page-context XHR/fetch interception
│   ├── observer.js          # MutationObserver for new tweets
│   ├── active-fetcher.js    # Priority queue, rate-limited requests
│   └── flag-renderer.js     # DOM manipulation
├── utils/
│   ├── cache.js             # Service worker cache client
│   ├── constants.js         # Message types, timing values
│   ├── country-flags.js     # Country name → flag filename map
│   └── browser-compat.js    # Firefox/Chrome API abstraction
├── popup/
│   ├── popup.html/css/js    # Settings UI
└── icons/flags/             # 4chan PNG flags
```

## Known Issues

- Accounts may occasionally get stuck with a loading icon—scrolling usually resolves this
- Power users will hit rate limits frequently; the local cache grows over time and reduces API calls

## Disclaimer

This extension uses X's internal `AboutAccountQuery` GraphQL endpoint. While the extension is conservative with request frequency, use at your own risk—X may not appreciate unofficial API usage.

## License

GPLv3+

The included 4chan PNG flags are not licensed under the GPL.
