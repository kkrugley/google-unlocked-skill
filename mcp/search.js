const { DOMParser } = require('linkedom');
const core = require('../src/core');
const googleDomains = require('../src/google-domains.json');

const LUMEN = 'https://lumendatabase.org';
const LUMEN_DAY = 24 * 60 * 60 * 1000;
const MAX_NOTICES = 8;
const MAX_DOMAINS = 30;
const TOOL_BUDGET_MS = 40000;

function googleUrl(query, region) {
  const url = new URL('https://www.google.' + region + '/search');
  url.searchParams.set('q', query);
  return url;
}

function linkTarget(href, google) {
  try {
    const url = new URL(href, google);
    if (url.origin === google.origin && url.pathname === '/url') {
      return new URL(url.searchParams.get('q') || url.searchParams.get('url'));
    }
    return url;
  } catch {
    return null;
  }
}

function noticeIds(doc, google) {
  const ids = new Set();
  for (const a of doc.querySelectorAll('a[href*="lumendatabase.org"]')) {
    if (a.querySelector('h3')) continue;
    const url = linkTarget(a.getAttribute('href'), google);
    if (url?.origin !== LUMEN || url.username || url.password) continue;
    const match = /^\/notices\/(\d{1,20})\/?$/.exec(url.pathname);
    if (match) ids.add(match[1]);
  }
  return [...ids];
}

function googleResults(doc, google, limit) {
  const results = new Map();
  for (const heading of doc.querySelectorAll('a h3')) {
    const title = heading.textContent.trim();
    const url = linkTarget(heading.closest('a').getAttribute('href'), google);
    if (title && url && ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password
        && url.origin !== google.origin && !results.has(url.href)) {
      results.set(url.href, { title: title.slice(0, 300), url: url.href });
    }
    if (results.size >= limit) break;
  }
  return [...results.values()];
}

function retryTime(header, fallback, now) {
  if (header && /^\d{1,10}$/.test(header)) return now + Number(header) * 1000;
  const date = Date.parse(header);
  return date > now ? date : fallback;
}

function createSearch(browser, { token = '', request = fetch, now = Date.now } = {}) {
  const cache = new Map();
  let stamps = [];
  let blockedUntil = 0;
  let busy = false;

  async function readNotice(id, url) {
    const cached = cache.get(id);
    if (cached && cached.expiresAt > now()) return { data: cached.data };
    const time = now();
    stamps = stamps.filter((stamp) => stamp > time - 3600000);
    const limits = token ? core.LIMITS_TOKEN : core.LIMITS_ANON;
    const budget = core.budgetCheck(stamps, time, blockedUntil, limits);
    if (budget.limited) return { status: 'rate_limited', retry_at: new Date(budget.resumeAt).toISOString() };
    stamps.push(time);

    try {
      let data;
      if (token) {
        const response = await request(url + '.json', {
          headers: { 'X-Authentication-Token': token, Accept: 'application/json' },
          redirect: 'manual',
          signal: AbortSignal.timeout(8000),
        });
        if (response.status === 429) {
          blockedUntil = retryTime(response.headers.get('retry-after'), core.nextHourStart(time), time);
          return { status: 'rate_limited', retry_at: new Date(blockedUntil).toISOString() };
        }
        if ([401, 403].includes(response.status)) return { status: 'token_rejected' };
        if ([404, 410].includes(response.status)) return { status: 'unavailable' };
        if (!response.ok) return { status: 'http_error', http_status: response.status };
        const json = await response.json();
        const notice = [json, ...Object.values(json || {})].find((value) => Array.isArray(value?.works));
        if (!notice) return { status: 'unexpected_response' };
        data = core.parseNoticeJson(notice);
      } else {
        const page = await browser.read(url);
        if (page.status === 429) {
          blockedUntil = retryTime(page.retryAfter, core.nextHourStart(time), time);
          return { status: 'rate_limited', retry_at: new Date(blockedUntil).toISOString() };
        }
        const gate = core.detectGate(page.html, page.url);
        if (gate || page.status === 403) {
          page.preserveChallenge();
          return { status: 'browser_verification', challenge: gate || 'access_denied' };
        }
        page.clearChallenge();
        if ([404, 410].includes(page.status)) return { status: 'unavailable' };
        if (page.status && page.status !== 200) return { status: 'http_error', http_status: page.status };
        const finalUrl = new URL(page.url);
        if (finalUrl.origin !== LUMEN || finalUrl.pathname.replace(/\/$/, '') !== '/notices/' + id) {
          return { status: 'unexpected_response' };
        }
        data = core.parseNotice(page.html, DOMParser);
        if (!data.works.length) return { status: 'unexpected_response' };
      }
      if (cache.size >= 128) cache.delete(cache.keys().next().value);
      cache.set(id, { data, expiresAt: now() + 30 * LUMEN_DAY });
      return { data };
    } catch {
      return { status: 'request_failed' };
    }
  }

  return async function search({ query, region = 'com', result_limit = 10, notice_ids: suppliedIds }) {
    const google = googleUrl(query, region);
    if (busy) return { status: 'busy', google_url: google.href };
    busy = true;
    const deadline = now() + TOOL_BUDGET_MS;
    try {
      const result = { google_url: google.href, google_status: 'not_requested', results: [], notices: [], domains: [] };
      let ids = [...new Set(suppliedIds || [])];
      if (!suppliedIds) {
        let page;
        try {
          page = await browser.read(google.href, { google: true });
        } catch (error) {
          if (error.message.startsWith('Cannot start Chromium')) throw error;
          result.google_status = 'request_failed';
          return result;
        }
        const finalUrl = new URL(page.url);
        if (finalUrl.hostname.startsWith('consent.google.') || /^\/sorry(?:\/|$)/.test(finalUrl.pathname)
            || page.status === 429 || page.status === 403) {
          page.preserveChallenge();
          result.google_status = page.status === 429 ? 'rate_limited' : 'browser_verification';
          if (page.status === 429 && page.retryAfter) {
            const time = now();
            result.google_retry_at = new Date(retryTime(page.retryAfter, time + 60000, time)).toISOString();
          }
          return result;
        }
        const doc = new DOMParser().parseFromString(page.html, 'text/html');
        if (finalUrl.origin !== google.origin || finalUrl.pathname !== '/search'
            || (page.status && page.status !== 200)) {
          result.google_status = 'unexpected_response';
          return result;
        }
        ids = noticeIds(doc, google);
        result.results = googleResults(doc, google, result_limit);
        if (!ids.length && !result.results.length && !doc.querySelector('#search, #rso, #topstuff')) {
          page.preserveChallenge();
          result.google_status = 'results_page_unavailable';
          return result;
        }
        page.clearChallenge();
        result.google_status = 'ok';
      }

      result.notice_ids_found = ids.length;
      const loaded = [];
      let paused = false;
      for (const id of ids.slice(0, MAX_NOTICES)) {
        const url = LUMEN + '/notices/' + id;
        if (paused || now() >= deadline) {
          result.notices.push({ id, url, status: 'deferred' });
          continue;
        }
        const { data, ...outcome } = await readNotice(id, url);
        if (data) loaded.push({ url, data });
        result.notices.push({ id, url, ...(data ? { status: 'ok' } : outcome) });
        paused = ['browser_verification', 'rate_limited', 'token_rejected'].includes(outcome.status);
      }
      const sources = new Map();
      for (const { url, data } of loaded) {
        for (const { domains } of data.works) {
          for (const { domain } of domains) {
            if (!sources.has(domain)) sources.set(domain, new Set());
            sources.get(domain).add(url);
          }
        }
      }
      const rows = core.aggregate(loaded.map(({ data }) => data));
      result.domains_found = rows.length;
      result.domains = rows.slice(0, MAX_DOMAINS).map(({ domain, count, urls }) => ({
        domain, count, notice_urls: [...sources.get(domain)],
        site_search_url: core.buildSiteSearchUrl(google, domain),
        ...(urls.length ? { reported_urls: urls.slice(0, 5) } : {}),
      }));
      return result;
    } finally {
      busy = false;
    }
  };
}

module.exports = { createSearch, googleDomains, MAX_NOTICES };
