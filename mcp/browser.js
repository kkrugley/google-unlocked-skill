const { chromium } = require('playwright-core');

function createBrowser({
  headless = process.env.GOOGLE_UNLOCKED_HEADLESS !== '0',
  executablePath = process.env.GOOGLE_UNLOCKED_CHROME || undefined,
} = {}) {
  let browser;
  let context;
  const tabs = new Map();

  async function read(url, { google = false } = {}) {
    if (!browser?.isConnected()) {
      try {
        browser = await chromium.launch({ headless, executablePath, chromiumSandbox: true, timeout: 10000 });
        context = await browser.newContext();
        tabs.clear();
      } catch {
        await browser?.close();
        throw new Error('Cannot start Chromium. Check the browser installation and display settings.');
      }
    }

    const tab = google ? 'google' : 'lumen';
    let state = tabs.get(tab);
    if (!state || state.page.isClosed()) {
      state = { page: await context.newPage() };
      tabs.set(tab, state);
    }
    const { page } = state;
    let response;
    if (state.challengeFor !== url || page.url() === state.challengeAt) {
      response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 8000 });
    }
    const status = response?.status();
    if (google && (!status || status === 200) && new URL(page.url()).pathname === '/search') {
      await page.locator('#search, #rso, #botstuff, #topstuff, a[href*="lumendatabase.org"]')
        .first().waitFor({ state: 'attached', timeout: 5000 }).catch(() => {});
    }
    return {
      status,
      retryAfter: response?.headers()['retry-after'],
      url: page.url(),
      html: await page.content(),
      preserveChallenge() {
        state.challengeFor = url;
        state.challengeAt = page.url();
      },
      clearChallenge() {
        state.challengeFor = undefined;
        state.challengeAt = undefined;
      },
    };
  }

  return {
    read,
    async close() {
      await browser?.close();
    },
  };
}

module.exports = { createBrowser };
