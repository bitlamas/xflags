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
 *
 * @class
 */
class ConsoleLogger {
  constructor() {
    this.logs = [];
    this.maxLogs = 100; // keep last 100 log entries
    this.currentFetcherState = 'active'; // 'active' | 'idle' | 'rate-limited'
  }

  /**
   * Add a log entry
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

    const prefix = '[xflags]';
    switch (type) {
      case 'fetch':
        console.log(`${prefix} ✓ ${message}`);
        break;
      case 'error':
        console.error(`${prefix} ✗ ${message}`);
        break;
      case 'status':
        console.warn(`${prefix} ${message}`);
        break;
      case 'info':
      default:
        console.log(`${prefix} ${message}`);
    }
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
   * @returns {Array} Array of log entries
   */
  getLogs() {
    return this.logs;
  }

  /**
   * Get logs since a timestamp
   * @param {number} since - Timestamp
   * @returns {Array} Array of log entries after timestamp
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
      case 'fetch': return '✓';
      case 'error': return '✗';
      case 'status': return '⚠';
      case 'info': return 'ℹ';
      default: return '·';
    }
  }

  /**
   * Clear all logs
   */
  clear() {
    this.logs = [];
  }

  /**
   * Get summary stats
   * @returns {Object} Stats object
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
