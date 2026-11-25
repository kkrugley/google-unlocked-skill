const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { createSearch } = require('../mcp/search');

const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

function browserPage(url, html, status = 200) {
  return { url, html, status, preserveChallenge() {}, clearChallenge() {} };
}

test('MCP search reports ordinary links and domains with their Lumen sources', async () => {
  const requested = [];
  const browser = {
    async read(url, options) {
      requested.push(url);
      if (!options?.google) {
        return browserPage(url, fixture('notice.html'), url.endsWith('/86034604') ? 200 : 404);
      }
      return browserPage(url, fixture('serp.html').replace('>Result</a>', '><h3>Ordinary result</h3></a>')
        .replace('href="https://lumendatabase.org/notices/86034604"', 'href="/url?q=https%3A%2F%2Flumendatabase.org%2Fnotices%2F86034604"')
        .replace('</body>', '<a href="https://example.org/lumendatabase.org/notices/42">Unrelated</a></body>'));
    },
  };
  const result = await createSearch(browser)({ query: 'Film & TV', region: 'co.uk' });
  assert.equal(result.google_status, 'ok');
  assert.deepEqual(result.results, [{ title: 'Ordinary result', url: 'https://example.com/' }]);
  assert.equal(result.notice_ids_found, 4);
  assert.equal(requested.length, 5);
  assert.equal(result.notices[1].status, 'unavailable');
  const domain = result.domains[0];
  assert.equal(domain.domain, 'kinozal.tv');
  assert.equal(domain.count, 22);
  assert.deepEqual(domain.notice_urls, ['https://lumendatabase.org/notices/86034604']);
  assert.equal(new URL(domain.site_search_url).hostname, 'www.google.co.uk');
  assert.equal(new URL(domain.site_search_url).searchParams.get('q'), 'site:kinozal.tv Film & TV');
});

test('MCP reports a Lumen challenge, leaves unprocessed notices pending and can resume', async () => {
  const requested = [];
  let firstAttempt = true;
  const browser = {
    async read(url) {
      requested.push(url);
      if (firstAttempt) {
        firstAttempt = false;
        const page = browserPage('https://lumendatabase.org/captcha_gateway', fixture('captcha.html'));
        page.preserveChallenge = () => requested.push('browser_preserved');
        return page;
      }
      return browserPage(url, fixture('notice.html'));
    },
  };
  const search = createSearch(browser);
  const args = { query: 'Film', notice_ids: ['1', '2'] };
  const partial = await search(args);
  assert.equal(partial.google_status, 'not_requested');
  assert.deepEqual(partial.notices.map(({ status }) => status), ['browser_verification', 'deferred']);
  assert.deepEqual(requested, ['https://lumendatabase.org/notices/1', 'browser_preserved']);

  const complete = await search(args);
  assert.deepEqual(complete.notices.map(({ status }) => status), ['ok', 'ok']);
  assert.equal(complete.domains[0].notice_urls.length, 2);
  await search(args);
  assert.equal(requested.length, 4, 'the next call reuses successful notices');
});

test('MCP Lumen API respects Retry-After and reports URLs when access resumes', async () => {
  let time = Date.UTC(2026, 10, 25, 9);
  let calls = 0;
  const request = async (url, options) => {
    assert.match(url, /^https:\/\/lumendatabase\.org\/notices\/1\.json$/);
    assert.equal(options.redirect, 'manual');
    assert.equal(options.headers['X-Authentication-Token'], 'test-token');
    if (++calls === 1) return new Response('', { status: 429, headers: { 'Retry-After': '15' } });
    return new Response(fixture('notice.json'));
  };
  const search = createSearch(null, { token: 'test-token', request, now: () => time });
  const args = { query: 'Film', notice_ids: ['1', '2'] };
  const throttled = await search(args);
  assert.equal(throttled.notices[0].retry_at, '2026-11-25T09:00:15.000Z');
  assert.equal(throttled.notices[1].status, 'deferred');
  await search(args);
  assert.equal(calls, 1);
  time += 15000;
  const result = await search({ ...args, notice_ids: ['1'] });
  assert.equal(calls, 2);
  assert.equal(result.notices[0].status, 'ok');
  assert.equal(result.domains[0].reported_urls.length, 5);
});

test('stdio MCP advertises the search tool and rejects invalid inputs', async (t) => {
  const client = new Client({ name: 'google-unlocked-test', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [path.join(__dirname, '..', 'mcp', 'index.js')],
  }));
  const { tools } = await client.listTools();
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, 'search_google_unlocked');
  assert.equal(tools[0].annotations.readOnlyHint, true);
  const result = await client.callTool({
    name: 'search_google_unlocked',
    arguments: { query: 'Film', notice_ids: ['https://example.com/1'] },
  });
  assert.equal(result.isError, true);
});
