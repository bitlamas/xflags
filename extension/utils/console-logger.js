// console logger for displaying activity in popup

/**
 * ConsoleLogger - Manages activity logs for popup display
 *
 * Features:
 * - Rolling log buffer (max 100 entries)
 * - Log types: fetch, error, status, info
 * - Fetcher state tracking (active/idle/rate-limited)
 * - Formatted output for popup UI
 * - Statistics aggregation
 * - Debounced console output to prevent flooding in high-activity scenarios
 *
 * @class
 */
class ConsoleLogger {
  constructor() {
    /** @type {Array<{timestamp: number, type: string, message: string}>} */
    this.logs = [];

    /** @type {number} Maximum number of log entries to keep */
    this.maxLogs = 100;

    /** @type {string} Current fetcher state */
    this.currentFetcherState = 'active'; // 'active' | 'idle' | 'rate-limited'

    /** @type {Array<{type: string, message: string}>} Pending logs to write to console */
    this.pendingConsoleLogs = [];

    /** @type {number|null} Debounce timer for console output */
    this.consoleDebounceTimer = null;

    /** @type {number} Debounce delay in milliseconds */
    this.consoleDebounceDelay = 100;
  }

  /**
   * Add a log entry
   * Logs are immediately added to the internal buffer but console output is debounced
   * @param {string} type - Type of log: 'fetch', 'error', 'status', 'info'
   * @param {string} message - Log message
   */
  log(type, message) {
    const entry = {
      timestamp: Date.now(),
      type: type,
      message: message
    };

    this.logs.push(entry);

    if (this.logs.length > this.maxLogs) {
      this.logs.shift();
    }

    // Queue console output and debounce
    this.pendingConsoleLogs.push({ type, message });
    this.scheduleConsoleFlush();
  }

  /**
   * Schedule a debounced flush of pending console logs
   * This prevents console flooding in high-activity scenarios
   * @private
   */
  scheduleConsoleFlush() {
    if (this.consoleDebounceTimer !== null) {
      clearTimeout(this.consoleDebounceTimer);
    }

    this.consoleDebounceTimer = setTimeout(() => {
      this.flushConsoleLogs();
      this.consoleDebounceTimer = null;
    }, this.consoleDebounceDelay);
  }

  /**
   * Flush all pending logs to the console
   * Groups similar log types together for cleaner output
   * @private
   */
  flushConsoleLogs() {
    if (this.pendingConsoleLogs.length === 0) return;

    const prefix = '[xflags]';

    // If there are many pending logs, summarize them
    if (this.pendingConsoleLogs.length > 10) {
      const counts = { fetch: 0, error: 0, status: 0, info: 0 };
      for (const log of this.pendingConsoleLogs) {
        counts[log.type] = (counts[log.type] || 0) + 1;
      }

      const summary = Object.entries(counts)
        .filter(([, count]) => count > 0)
        .map(([type, count]) => `${type}: ${count}`)
        .join(', ');

      console.log(`${prefix} Batch: ${summary}`);

      // Still log errors individually as they're important
      for (const log of this.pendingConsoleLogs) {
        if (log.type === 'error') {
          console.error(`${prefix} [X] ${log.message}`);
        }
      }
    } else {
      // Log each entry individually
      for (const log of this.pendingConsoleLogs) {
        switch (log.type) {
          case 'fetch':
            console.log(`${prefix} [OK] ${log.message}`);
            break;
          case 'error':
            console.error(`${prefix} [X] ${log.message}`);
            break;
          case 'status':
            console.warn(`${prefix} ${log.message}`);
            break;
          case 'info':
          default:
            console.log(`${prefix} ${log.message}`);
        }
      }
    }

    this.pendingConsoleLogs = [];
  }

  /**
   * Set the current fetcher state
   * @param {string} state - State: 'active', 'idle', or 'rate-limited'
   */
  setFetcherState(state) {
    this.currentFetcherState = state;
  }

  /**
   * Get all logs
   * @returns {Array<{timestamp: number, type: string, message: string}>} Array of log entries
   */
  getLogs() {
    return this.logs;
  }

  /**
   * Get logs since a timestamp
   * @param {number} since - Timestamp
   * @returns {Array<{timestamp: number, type: string, message: string}>} Array of log entries after timestamp
   */
  getLogsSince(since) {
    return this.logs.filter(log => log.timestamp > since);
  }

  /**
   * Get formatted log text for display
   * @returns {string} Formatted log text
   */
  getFormattedLogs() {
    if (this.logs.length === 0) {
      return 'No activity yet...';
    }

    return this.logs.map(log => {
      const time = new Date(log.timestamp).toLocaleTimeString();
      const icon = this.getIconForType(log.type);
      return `[${time}] ${icon} ${log.message}`;
    }).join('\n');
  }

  /**
   * Get icon for log type
   * @param {string} type - Log type
   * @returns {string} Icon character
   */
  getIconForType(type) {
    switch (type) {
      case 'fetch': return '[OK]';
      case 'error': return '[X]';
      case 'status': return '[!]';
      case 'info': return '[i]';
      default: return '[-]';
    }
  }

  /**
   * Clear all logs
   */
  clear() {
    this.logs = [];
    this.pendingConsoleLogs = [];
    if (this.consoleDebounceTimer !== null) {
      clearTimeout(this.consoleDebounceTimer);
      this.consoleDebounceTimer = null;
    }
  }

  /**
   * Get summary stats
   * @returns {{total: number, fetches: number, errors: number, rateLimited: boolean, idle: boolean}} Stats object
   */
  getStats() {
    const totalFetches = this.logs.filter(log => log.type === 'fetch').length;

    const stats = {
      total: this.logs.length,
      fetches: totalFetches,
      errors: this.logs.filter(log => log.type === 'error').length,
      rateLimited: this.currentFetcherState === 'rate-limited',
      idle: this.currentFetcherState === 'idle' || this.currentFetcherState === 'rate-limited'
    };

    return stats;
  }
}

if (typeof window !== 'undefined') {
  window.xflagConsole = new ConsoleLogger();
}
