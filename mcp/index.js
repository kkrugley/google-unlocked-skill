const { createServer } = require('node:http');
const { timingSafeEqual } = require('node:crypto');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { z } = require('zod');
const { version } = require('../package.json');
const { createBrowser } = require('./browser');
const { createSearch, googleDomains, MAX_NOTICES } = require('./search');

const browser = createBrowser();
const search = createSearch(browser, { token: process.env.LUMEN_TOKEN?.trim() });

function makeServer() {
  const mcp = new McpServer({ name: 'google-unlocked', version }, {
    instructions: 'Search Google and inspect the Lumen complaints linked on its result page. Cite notice_urls for reported domains and label them as allegations. If browser_verification is returned, ask the user to complete the check in a visible Chromium session before repeating the same call. Respect any retry time returned by the tool.',
  });
  mcp.registerTool('search_google_unlocked', {
    title: 'Google Unlocked search',
    description: 'Search Google and find domains and URL counts in linked Lumen DMCA complaints. Returns Google results, source notices, and site-specific Google links. Supply known Lumen notice IDs to look them up directly when Google access is unavailable.',
    inputSchema: {
      query: z.string().trim().min(1).max(500).describe('Original Google query used in the search and site: links'),
      region: z.enum(googleDomains).default('com').describe('Google domain suffix such as com, de, or co.uk'),
      result_limit: z.number().int().min(1).max(20).default(10).describe('Maximum number of ordinary Google results'),
      notice_ids: z.array(z.string().regex(/^\d{1,20}$/)).min(1).max(MAX_NOTICES).optional()
        .describe('Known Lumen complaint IDs. If supplied, skip the Google results page.'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true, idempotentHint: true },
  }, async (args) => {
    try {
      const result = await search(args);
      return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    } catch (error) {
      const text = error.message.startsWith('Cannot start Chromium')
        ? error.message : 'Google Unlocked could not complete the request.';
      return { isError: true, content: [{ type: 'text', text }] };
    }
  });
  return mcp;
}

function serveHttp() {
  const port = Number(process.env.PORT || '8765');
  const token = process.env.GOOGLE_UNLOCKED_MCP_TOKEN?.trim();
  const expected = token && Buffer.from('Bearer ' + token);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');

  const http = createServer(async (req, res) => {
    if (req.url !== '/mcp') return res.writeHead(404).end();
    if (req.headers.origin) return res.writeHead(403).end();
    if (expected) {
      const supplied = Buffer.from(req.headers.authorization || '');
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
        return res.writeHead(401, { 'WWW-Authenticate': 'Bearer' }).end();
      }
    }

    const mcp = makeServer();
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
    res.on('close', () => { void mcp.close(); });
    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res);
    } catch {
      if (!res.headersSent) res.writeHead(500);
      if (!res.writableEnded) res.end();
    }
  });
  http.on('error', (error) => {
    console.error('Unable to listen on loopback:', error.code);
    process.exitCode = 1;
  });
  http.listen(port, '127.0.0.1', () => console.error('Google Unlocked MCP on http://127.0.0.1:' + port + '/mcp'));
}

async function main() {
  if (process.argv[2] === '--http') {
    serveHttp();
  } else if (process.argv.length === 2) {
    const server = makeServer();
    const transport = new StdioServerTransport();
    server.server.onclose = () => { void browser.close(); };
    await server.connect(transport);
    process.stdin.once('end', () => { void browser.close(); });
  } else {
    throw new Error('Usage: node mcp/index.js [--http]');
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    await browser.close();
    process.exit(0);
  });
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
