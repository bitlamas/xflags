// cross-browser compatibility for chrome and firefox

const isFirefox = typeof browser !== 'undefined';
const browserAPI = isFirefox ? browser : chrome;

const storage = {
  async get(key) {
    if (isFirefox) {
      const result = await browser.storage.local.get(key);
      return result[key];
    } else {
      return new Promise((resolve) => {
        chrome.storage.local.get(key, (result) => resolve(result[key]));
      });
    }
  },

  async set(key, value) {
    if (isFirefox) {
      await browser.storage.local.set({ [key]: value });
    } else {
      return new Promise((resolve) => {
        chrome.storage.local.set({ [key]: value }, resolve);
      });
    }
  },

  async remove(key) {
    if (isFirefox) {
      await browser.storage.local.remove(key);
    } else {
      return new Promise((resolve) => {
        chrome.storage.local.remove(key, resolve);
      });
    }
  }
};

const runtime = {
  getURL(path) {
    return browserAPI.runtime.getURL(path);
  },

  sendMessage(message) {
    return browserAPI.runtime.sendMessage(message);
  },

  onMessage: browserAPI.runtime.onMessage
};

if (typeof window !== 'undefined') {
  window.xflagBrowser = {
    storage,
    runtime,
    isFirefox
  };
}
