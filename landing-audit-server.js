'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const HOST = '127.0.0.1';
const PORT = 8791;
const ROOT = __dirname;

const PUBLIC_FILES = new Map([
  ['/landing.html', 'landing.html'],
  ['/landing-v2.html', 'landing-v2.html'],
]);

const server = http.createServer((request, response) => {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Cache-Control', 'no-store');

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD' });
    response.end('Method Not Allowed');
    return;
  }

  let pathname;
  try {
    pathname = new URL(request.url, `http://${HOST}:${PORT}`).pathname;
  } catch {
    response.writeHead(400);
    response.end('Bad Request');
    return;
  }

  if (pathname === '/') {
    response.writeHead(302, { Location: '/landing.html' });
    response.end();
    return;
  }

  const filename = PUBLIC_FILES.get(pathname);
  if (!filename) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not Found');
    return;
  }

  const filePath = path.join(ROOT, filename);
  fs.stat(filePath, (statError, stats) => {
    if (statError || !stats.isFile()) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Not Found');
      return;
    }

    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': stats.size,
    });

    if (request.method === 'HEAD') {
      response.end();
      return;
    }

    const stream = fs.createReadStream(filePath);
    stream.on('error', () => response.destroy());
    stream.pipe(response);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Landing audit server: http://${HOST}:${PORT}/landing.html`);
});

