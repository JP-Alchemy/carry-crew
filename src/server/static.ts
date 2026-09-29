import { createReadStream, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

function fileAt(path: string): { size: number; mtime: Date } | null {
  try {
    const st = statSync(path);
    return st.isFile() ? { size: st.size, mtime: st.mtime } : null;
  } catch {
    return null;
  }
}

/** Serves the built client with an SPA fallback to index.html. */
export function serveStatic(root: string, req: IncomingMessage, res: ServerResponse, pathname: string) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' }).end();
    return;
  }
  const base = resolve(root);
  let rel: string;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    res.writeHead(400).end();
    return;
  }
  if (rel.includes('\0')) {
    res.writeHead(400).end();
    return;
  }
  let file = normalize(join(base, rel));
  if (file !== base && !file.startsWith(base + sep)) {
    res.writeHead(403).end();
    return;
  }
  let st = rel.endsWith('/') ? null : fileAt(file);
  if (!st) {
    // Unknown asset-looking paths are real 404s; everything else is a client-side route.
    if (extname(rel) && extname(rel) !== '.html') {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found');
      return;
    }
    file = join(base, 'index.html');
    st = fileAt(file);
    if (!st) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Client not built (run `npm run build`).');
      return;
    }
  }
  const ext = extname(file).toLowerCase();
  const hashed = rel.startsWith('/assets/');
  const headers: Record<string, string | number> = {
    'content-type': TYPES[ext] ?? 'application/octet-stream',
    'content-length': st.size,
    'last-modified': st.mtime.toUTCString(),
    'x-content-type-options': 'nosniff',
    'cache-control': hashed ? 'public, max-age=31536000, immutable' : ext === '.html' ? 'no-cache' : 'public, max-age=3600',
  };
  const ims = req.headers['if-modified-since'];
  if (!hashed && ims && Math.floor(st.mtime.getTime() / 1000) <= Math.floor(Date.parse(ims) / 1000)) {
    res.writeHead(304, { 'cache-control': headers['cache-control'] as string }).end();
    return;
  }
  res.writeHead(200, headers);
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  const stream = createReadStream(file);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}
