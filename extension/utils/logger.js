// test logger - tracks flag fetches and 429 errors

const LOGGER_KEY = 'xflag_test_log';

class TestLogger {
  constructor() {
    this.entries = [];
    this.flagCount = 0;
    this.first429 = null;
    this.testStartTime = null;
    this.loaded = false;
  }

  async load() {
    if (this.loaded) return;

    try {
      const saved = await window.xflagBrowser.storage.get(LOGGER_KEY);
      if (saved) {
        this.entries = saved.entries || [];
        this.flagCount = saved.flagCount || 0;
        this.first429 = saved.first429 || null;
        this.testStartTime = saved.testStartTime || null;
      }
      this.loaded = true;
    } catch (error) {
      console.error('[XFlag Logger] Error loading log:', error);
      this.loaded = true;
    }
  }

  async startNewTest() {
    this.entries = [];
    this.flagCount = 0;
    this.first429 = null;
    this.testStartTime = Date.now();
    await this.save();
    console.log('[XFlag Logger] Test started');
  }

  async logFlagFetched(username, location, accurate) {
    if (this.first429) return; // stop logging after first 429

    this.flagCount++;
    const entry = {
      timestamp: Date.now(),
      type: 'FLAG_FETCHED',
      username: username,
      location: location,
      accurate: accurate,
      count: this.flagCount
    };

    this.entries.push(entry);
    console.log(`[XFlag Logger] Flag #${this.flagCount}: ${username} → ${location}`);

    await this.save();
  }

  async log429Error() {
    if (this.first429) return;

    this.first429 = Date.now();
    const entry = {
      timestamp: this.first429,
      type: '429_ERROR',
      flagsBeforeError: this.flagCount,
      testDuration: this.testStartTime ? this.first429 - this.testStartTime : null
    };

    this.entries.push(entry);
    console.log(`[XFlag Logger] ⚠️ FIRST 429 ERROR after ${this.flagCount} flags`);

    await this.save();
  }

  async save() {
    try {
      await window.xflagBrowser.storage.set(LOGGER_KEY, {
        entries: this.entries,
        flagCount: this.flagCount,
        first429: this.first429,
        testStartTime: this.testStartTime
      });
    } catch (error) {
      console.error('[XFlag Logger] Error saving log:', error);
    }
  }

  getStats() {
    return {
      flagCount: this.flagCount,
      first429: this.first429,
      testStartTime: this.testStartTime,
      testDuration: this.first429 && this.testStartTime ?
        this.first429 - this.testStartTime :
        (this.testStartTime ? Date.now() - this.testStartTime : null),
      entriesCount: this.entries.length
    };
  }

  exportLog() {
    const stats = this.getStats();

    let output = '=== XFlag Test Log ===\n\n';
    output += `Test Started: ${this.testStartTime ? new Date(this.testStartTime).toISOString() : 'N/A'}\n`;
    output += `Total Flags Fetched: ${this.flagCount}\n`;

    if (this.first429) {
      const duration = this.first429 - this.testStartTime;
      const minutes = Math.floor(duration / 60000);
      const seconds = Math.floor((duration % 60000) / 1000);
      output += `First 429 Error: ${new Date(this.first429).toISOString()}\n`;
      output += `Flags Before Error: ${this.flagCount}\n`;
      output += `Test Duration: ${minutes}m ${seconds}s\n`;
    } else {
      if (this.testStartTime) {
        const duration = Date.now() - this.testStartTime;
        const minutes = Math.floor(duration / 60000);
        const seconds = Math.floor((duration % 60000) / 1000);
        output += `Status: No 429 error yet\n`;
        output += `Test Duration: ${minutes}m ${seconds}s\n`;
      }
    }

    output += '\n=== Detailed Log ===\n\n';

    for (const entry of this.entries) {
      const timestamp = new Date(entry.timestamp).toISOString();

      if (entry.type === 'FLAG_FETCHED') {
        output += `[${timestamp}] #${entry.count} - ${entry.username} → ${entry.location} (accurate: ${entry.accurate})\n`;
      } else if (entry.type === '429_ERROR') {
        output += `\n[${timestamp}] ⚠️ FIRST 429 ERROR\n`;
        output += `Flags fetched before error: ${entry.flagsBeforeError}\n`;
        if (entry.testDuration) {
          const minutes = Math.floor(entry.testDuration / 60000);
          const seconds = Math.floor((entry.testDuration % 60000) / 1000);
          output += `Test duration: ${minutes}m ${seconds}s\n`;
        }
      }
    }

    return output;
  }

  async clear() {
    this.entries = [];
    this.flagCount = 0;
    this.first429 = null;
    this.testStartTime = null;
    await window.xflagBrowser.storage.remove(LOGGER_KEY);
    console.log('[XFlag Logger] Log cleared');
  }
}

if (typeof window !== 'undefined') {
  window.xflagLogger = new TestLogger();
}
