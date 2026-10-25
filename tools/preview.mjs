import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { buildSite, siteFiles } from './build-site.mjs';

const build = await buildSite(), prefix = '/ps-store-sale/';
const allowed = new Set(siteFiles);
createServer(async (request, response) => {
  const path = new URL(request.url, 'http://127.0.0.1:4186').pathname;
  if (path === '/') { response.writeHead(302, { Location: prefix }).end(); return; }
  const file = path.startsWith(prefix) ? path.slice(prefix.length) || 'index.html' : null;
  if (request.method !== 'GET' || !allowed.has(file)) { response.writeHead(404).end(); return; }
  try {
    const data = await readFile(resolve(build.directory, file));
    response.writeHead(200, { 'Content-Type': file.endsWith('.html') ? 'text/html; charset=utf-8'
      : file.endsWith('.css') ? 'text/css; charset=utf-8' : /\.m?js$/.test(file) ? 'text/javascript; charset=utf-8' : 'application/json',
      'Cache-Control': 'no-store', 'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Content-Security-Policy': "default-src 'self'; connect-src 'self' https://accounts.google.com/gsi/; img-src 'self' https://image.api.playstation.com https://gmedia.playstation.com; script-src 'self' https://accounts.google.com/gsi/client; frame-src https://accounts.google.com/gsi/; style-src 'self' https://accounts.google.com/gsi/style; object-src 'none'; base-uri 'none'" });
    response.end(data);
  } catch { response.writeHead(404).end(); }
}).listen(4186, '127.0.0.1', () => console.log(`Local preview: http://127.0.0.1:4186${prefix}`));
