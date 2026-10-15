const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

async function freePort() {
  const socket = net.createServer();
  await new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', resolve);
  });
  const { port } = socket.address();
  await new Promise(resolve => socket.close(resolve));
  return port;
}

test('server security regression', async t => {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  Object.assign(process.env, {
    HOST: '127.0.0.1',
    PORT: String(port),
    OPENAI_API_KEY: 'test-only-key',
    OPENAI_TIMEOUT_MS: '1000',
    RATE_LIMIT_WINDOW_MS: '60000',
    MAX_PARSE_REQUESTS: '2',
    MAX_CONCURRENT_PARSES: '1',
    ALLOWED_ORIGINS: 'http://allowed.invalid',
  });

  const { server, startServer } = require('./server');
  const listening = once(server, 'listening');
  startServer();
  await listening;

  try {
    await t.test('serves the app with security headers', async () => {
      const response = await fetch(`${baseUrl}/`);
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-security-policy') || '', /frame-ancestors 'none'/);
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      assert.match(await response.text(), /מודלים חישוביים/);
    });

    await t.test('serves only the public allowlist', async () => {
      for (const file of ['/.env', '/.secrets/openai.env', '/.git/config', '/server.js', '/landing.html']) {
        const response = await fetch(`${baseUrl}${file}`);
        assert.equal(response.status, 404, `${file} must not be public`);
      }
      const wrongMethod = await fetch(`${baseUrl}/automata.html`, { method: 'POST' });
      assert.equal(wrongMethod.status, 405);
    });

    await t.test('allows only explicit browser origins', async () => {
      const allowed = await fetch(`${baseUrl}/api/health`, { headers: { origin: baseUrl } });
      assert.equal(allowed.status, 200);
      assert.equal(allowed.headers.get('access-control-allow-origin'), baseUrl);

      const blocked = await fetch(`${baseUrl}/api/health`, { headers: { origin: 'https://evil.example' } });
      assert.equal(blocked.status, 403);
      assert.equal(blocked.headers.get('access-control-allow-origin'), null);

      const opaqueOrigin = await fetch(`${baseUrl}/api/health`, { headers: { origin: 'null' } });
      assert.equal(opaqueOrigin.status, 403);

      const preflight = await fetch(`${baseUrl}/api/parse-diagram`, {
        method: 'OPTIONS',
        headers: {
          origin: baseUrl,
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'content-type',
        },
      });
      assert.equal(preflight.status, 204);
      assert.equal(preflight.headers.get('access-control-allow-origin'), baseUrl);
    });

    await t.test('validates JSON and rate-limits scan attempts without calling OpenAI', async () => {
      const request = body => fetch(`${baseUrl}/api/parse-diagram`, {
        method: 'POST',
        headers: { origin: baseUrl, 'content-type': 'application/json' },
        body,
      });

      const malformed = await request('{');
      assert.equal(malformed.status, 400);
      assert.equal(malformed.headers.get('x-ratelimit-remaining'), '1');

      const empty = await request('{}');
      assert.equal(empty.status, 400);
      assert.equal(empty.headers.get('x-ratelimit-remaining'), '0');

      const limited = await request('{}');
      assert.equal(limited.status, 429);
      assert.ok(Number(limited.headers.get('retry-after')) >= 1);
    });

    await t.test('refuses non-loopback binding', async () => {
      const otherPort = await freePort();
      let output = '';
      const child = spawn(process.execPath, ['server.js'], {
        cwd: __dirname,
        env: { ...process.env, HOST: '0.0.0.0', PORT: String(otherPort) },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      child.stdout.on('data', chunk => { output += chunk.toString(); });
      child.stderr.on('data', chunk => { output += chunk.toString(); });
      const [exitCode] = await once(child, 'exit');
      assert.notEqual(exitCode, 0);
      assert.match(output, /Refusing to listen on non-loopback host/);
    });
  } finally {
    const closed = once(server, 'close');
    server.close();
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    await closed;
  }
});
