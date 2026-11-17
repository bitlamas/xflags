// rate-limit-policy.js - shared pacing / cooldown logic for X's AboutAccountQuery
//
// Loaded in two places:
// - the background (service worker in Chrome via importScripts, event page in Firefox)
//   where one RateBudget instance paces requests for ALL tabs
// - content scripts, where a local RateBudget is used as a fallback when the
//   background is unreachable
//
// Everything is attached to `self.XflagRatePolicy` to avoid polluting the shared
// global scope (Firefox background scripts and content scripts share one scope).

(function(global) {
  const POLICY = {
    // X reports its budget in x-rate-limit-* headers. Measured budget for
    // AboutAccountQuery is ~50 requests / 15 min per logged-in session.
    WINDOW_MS: 15 * 60 * 1000,
    // Keep this share of the window's budget in reserve (X's own UI uses the same budget)
    RESERVE_RATIO: 0.15,
    // Spacing bounds
    MIN_INTERVAL_MS: 2000,
    MAX_INTERVAL_MS: 2 * 60 * 1000,
    // Spacing used before we've seen any rate-limit headers
    DEFAULT_INTERVAL_MS: 5000,
    // Cooldown when a 429 carries no usable reset / retry-after header
    FALLBACK_COOLDOWN_MS: 5 * 60 * 1000,
    // Never trust a reset further away than this (clock skew / garbage headers)
    MAX_COOLDOWN_MS: 20 * 60 * 1000,
    MIN_COOLDOWN_MS: 10 * 1000,
    // Small safety margin after the reset time
    RESET_MARGIN_MS: 1000,
    // Per-request timeout (covers headers AND body)
    REQUEST_TIMEOUT_MS: 8000,
    // Retries for network errors / timeouts only
    MAX_RETRIES: 2,
    RETRY_BASE_MS: 2000
  };

  /**
   * Parse X's rate limit headers from a fetch Response
   * `x-rate-limit-reset` is an epoch in seconds on X's clock. We convert it to
   * a local timestamp using the response's Date header to cancel out clock skew.
   * @param {Response} response
   * @returns {{limit: number|null, remaining: number|null, resetAt: number|null, retryAfterMs: number|null}}
   */
  function parseRateLimitHeaders(response) {
    const h = response && response.headers;
    const result = { limit: null, remaining: null, resetAt: null, retryAfterMs: null };
    if (!h || typeof h.get !== 'function') return result;

    const toInt = (v) => {
      if (v === null || v === undefined || v === '') return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };

    result.limit = toInt(h.get('x-rate-limit-limit'));
    result.remaining = toInt(h.get('x-rate-limit-remaining'));

    const resetEpochSec = toInt(h.get('x-rate-limit-reset'));
    if (resetEpochSec !== null && resetEpochSec > 0) {
      const now = Date.now();
      const serverDate = Date.parse(h.get('date') || '');
      const serverNow = Number.isFinite(serverDate) ? serverDate : now;
      // milliseconds until reset, measured on the server's clock
      const untilReset = resetEpochSec * 1000 - serverNow;
      result.resetAt = now + Math.max(0, untilReset);
    }

    const retryAfter = h.get('retry-after');
    if (retryAfter) {
      const seconds = toInt(retryAfter);
      if (seconds !== null) {
        result.retryAfterMs = Math.max(0, seconds * 1000);
      } else {
        const date = Date.parse(retryAfter);
        if (Number.isFinite(date)) result.retryAfterMs = Math.max(0, date - Date.now());
      }
    }

    return result;
  }

  /**
   * Compute how long to cool down after a 429
   * @param {{resetAt: number|null, retryAfterMs: number|null}} info
   * @returns {number} cooldown in ms
   */
  function cooldownFor429(info) {
    const now = Date.now();
    let ms = null;

    if (info && info.resetAt && info.resetAt > now) {
      ms = info.resetAt - now + POLICY.RESET_MARGIN_MS;
    }
    if (info && info.retryAfterMs !== null && info.retryAfterMs !== undefined) {
      ms = Math.max(ms || 0, info.retryAfterMs + POLICY.RESET_MARGIN_MS);
    }
    if (ms === null) {
      ms = POLICY.FALLBACK_COOLDOWN_MS;
    }

    return Math.min(POLICY.MAX_COOLDOWN_MS, Math.max(POLICY.MIN_COOLDOWN_MS, ms));
  }

  /**
   * RateBudget - paces requests against X's reported budget
   *
   * Spreads the remaining budget (minus a reserve) evenly over the time left in
   * the current window, so we never burn through it and get a 429.
   */
  class RateBudget {
    constructor() {
      this.limit = null;
      this.remaining = null;
      this.resetAt = null;
      this.cooldownUntil = 0;
      this.lastSlotAt = 0;
    }

    /** Snapshot for persistence */
    toJSON() {
      return {
        limit: this.limit,
        remaining: this.remaining,
        resetAt: this.resetAt,
        cooldownUntil: this.cooldownUntil,
        lastSlotAt: this.lastSlotAt
      };
    }

    /** Restore from persistence */
    restore(state) {
      if (!state || typeof state !== 'object') return;
      for (const key of ['limit', 'remaining', 'resetAt', 'cooldownUntil', 'lastSlotAt']) {
        if (typeof state[key] === 'number' || state[key] === null) {
          this[key] = state[key];
        }
      }
    }

    /**
     * Record rate limit headers from a response
     * @param {{limit: number|null, remaining: number|null, resetAt: number|null}} info
     */
    update(info) {
      if (!info) return;
      if (info.limit !== null && info.limit !== undefined) this.limit = info.limit;
      if (info.remaining !== null && info.remaining !== undefined) this.remaining = info.remaining;
      if (info.resetAt) this.resetAt = info.resetAt;
    }

    /**
     * Enter cooldown until the given timestamp
     * @param {number} until - epoch ms
     */
    setCooldown(until) {
      this.cooldownUntil = Math.max(this.cooldownUntil, until);
      this.remaining = 0;
    }

    clearCooldown() {
      this.cooldownUntil = 0;
    }

    /** @returns {number} ms left in cooldown (0 if none) */
    cooldownRemaining() {
      return Math.max(0, this.cooldownUntil - Date.now());
    }

    /** @returns {boolean} true if the known budget for the current window is used up */
    #budgetSpent() {
      if (!this.resetAt || this.resetAt <= Date.now() || this.remaining === null) return false;
      const reserve = Math.ceil((this.limit || 50) * POLICY.RESERVE_RATIO);
      return this.remaining - reserve <= 0;
    }

    /**
     * Spacing between requests given what we know about the window
     * @returns {number} ms
     */
    currentInterval() {
      const now = Date.now();

      // Window info expired or unknown -> default spacing until a response tells us more
      if (!this.resetAt || this.resetAt <= now || this.remaining === null) {
        return POLICY.DEFAULT_INTERVAL_MS;
      }

      const limit = this.limit || 50;
      const reserve = Math.ceil(limit * POLICY.RESERVE_RATIO);
      const usable = this.remaining - reserve;
      const msLeft = this.resetAt - now;

      if (usable <= 0) {
        // Budget spent: wait for the window to reset
        return msLeft + POLICY.RESET_MARGIN_MS;
      }

      const interval = msLeft / usable;
      return Math.min(POLICY.MAX_INTERVAL_MS, Math.max(POLICY.MIN_INTERVAL_MS, interval));
    }

    /**
     * Reserve the next request slot
     * @returns {{waitMs: number, cooldown: boolean}} how long to wait before sending;
     *   cooldown=true means we're rate limited and the caller should defer instead
     */
    acquire() {
      const now = Date.now();
      const cooldownMs = this.cooldownRemaining();
      if (cooldownMs > 0) {
        return { waitMs: cooldownMs, cooldown: true };
      }

      let slotAt = Math.max(now, this.lastSlotAt + this.currentInterval());
      if (this.#budgetSpent()) {
        // Don't send anything until the window resets
        slotAt = Math.max(slotAt, this.resetAt + POLICY.RESET_MARGIN_MS);
      }
      this.lastSlotAt = slotAt;

      // Optimistically count the request so parallel tabs don't all spend the same unit
      if (this.remaining !== null && this.resetAt && this.resetAt > now) {
        this.remaining = Math.max(0, this.remaining - 1);
      }

      return { waitMs: slotAt - now, cooldown: false };
    }
  }

  global.XflagRatePolicy = {
    POLICY,
    parseRateLimitHeaders,
    cooldownFor429,
    RateBudget
  };
})(typeof self !== 'undefined' ? self : this);
