import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ttf': 'font/ttf',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
};

/**
 * A production-like static host whose root can be swapped mid-test, so a test can "deploy" a
 * newer build under the same origin. SPA fallback like the Cloudflare assets config; /room,
 * /api and /healthz are never the app.
 */
export async function startStaticServer(initialRoot: string): Promise<{
  readonly origin: string;
  setRoot(root: string): void;
  close(): Promise<void>;
}> {
  let root = initialRoot;
  const server: Server = createServer((request, response) => {
    void (async () => {
      const path = decodeURIComponent(new URL(request.url ?? '/', 'http://x').pathname);
      if (/^\/(?:room|api)(?:\/|$)|^\/healthz$/.test(path)) {
        response.writeHead(503).end();
        return;
      }
      const relative = normalize(path === '/' ? '/index.html' : path).replace(/^(\.\.[/\\])+/, '');
      let file = join(root, relative);
      let body: Buffer;
      try {
        body = await readFile(file);
      } catch {
        if (extname(relative)) {
          response.writeHead(404).end();
          return;
        }
        file = join(root, 'index.html');
        body = await readFile(file);
      }
      response.writeHead(200, {
        'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
        'cache-control': 'no-cache',
      });
      response.end(body);
    })().catch(() => response.writeHead(500).end());
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Static server has no port');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    setRoot(next) {
      root = next;
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
