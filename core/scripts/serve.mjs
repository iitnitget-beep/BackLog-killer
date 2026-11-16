// Minimal static server for the browser preview. Binds 0.0.0.0 so the Arena
// preview proxy can reach it, and sends no X-Frame-Options so it can be embedded.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const root = new URL('../dist/', import.meta.url).pathname;
const port = Number(process.env.PORT ?? 8080);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.map': 'application/json' };

createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  const requested = url.pathname === '/' ? '/index.html' : url.pathname;
  const file = join(root, normalize(requested).replace(/^(\.\.[/\\])+/, ''));
  try {
    const body = await readFile(file);
    response.writeHead(200, {
      'content-type': types[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    response.end(body);
  } catch {
    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end('not found');
  }
}).listen(port, '0.0.0.0', () => console.log(`ForgeX preview on http://0.0.0.0:${port}`));
