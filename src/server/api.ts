import type { IncomingMessage, ServerResponse } from 'node:http';
import { dailySpec, weeklySpec } from '../shared/courses';
import { isSafeName } from '../shared/names';
import type { Store } from './store';
import { clamp, finite, isBotName, isHexId, isObj, WindowLimiter } from './util';

const MAX_BODY = 64 * 1024;
const MAX_EVENTS = 200;

export interface ApiDeps {
  store: Store;
  stats: () => { online: number; rooms: number };
  postLimiter: WindowLimiter;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    msg: string,
  ) {
    super(msg);
  }
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-max-age': '86400',
};

function json(res: ServerResponse, status: number, body: unknown) {
  const text = JSON.stringify(body);
  res.writeHead(status, { ...CORS, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const len = Number(req.headers['content-length']);
    if (len > MAX_BODY) {
      reject(new HttpError(413, 'body too large'));
      req.resume();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    req.on('data', (c: Buffer) => {
      if (failed) return;
      size += c.length;
      if (size > MAX_BODY) {
        failed = true;
        reject(new HttpError(413, 'body too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => !failed && resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', (e) => !failed && reject(e));
  });
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  // Accepts application/json and text/plain (navigator.sendBeacon) alike.
  const text = await readBody(req);
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw new HttpError(400, 'invalid json');
  }
  if (!isObj(v)) throw new HttpError(400, 'expected an object');
  return v;
}

/** Client IP; forwarded headers are only trusted when the direct peer is a local/private proxy. */
export function clientIp(req: IncomingMessage): string {
  const direct = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
  const xff = req.headers['x-forwarded-for'];
  const privatePeer = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|f[cd][0-9a-f]{2}:)/i.test(direct);
  if (privatePeer && typeof xff === 'string' && xff) {
    const hops = xff.split(',').map((s) => s.trim()).filter(Boolean);
    if (hops.length) return hops[hops.length - 1];
  }
  return direct || 'unknown';
}

function cleanProps(p: unknown): Record<string, string | number | boolean> | undefined {
  if (!isObj(p)) return undefined;
  const out: Record<string, string | number | boolean> = {};
  let n = 0;
  for (const [k, v] of Object.entries(p)) {
    if (n >= 24 || k.length > 40) continue;
    if (typeof v === 'string') out[k] = v.slice(0, 120);
    else if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (typeof v === 'boolean') out[k] = v;
    else continue;
    n++;
  }
  return out;
}

export function validBoardKey(key: unknown): key is string {
  return key === `d${dailySpec().seed}` || key === `w${weeklySpec().seed}`;
}

async function handle(deps: ApiDeps, req: IncomingMessage, res: ServerResponse, path: string, query: URLSearchParams) {
  const { store } = deps;
  const method = req.method ?? 'GET';

  if (method === 'POST' && !deps.postLimiter.allow(`${clientIp(req)} ${path}`)) throw new HttpError(429, 'slow down');

  if (path === '/api/health' && method === 'GET') {
    return json(res, 200, { ok: true, ...deps.stats() });
  }

  if (path === '/api/events' && method === 'POST') {
    const body = await readJson(req);
    const id = isHexId(body.id) ? body.id : 'anon';
    const events = Array.isArray(body.events) ? body.events.slice(0, MAX_EVENTS) : [];
    const at = Date.now();
    for (const ev of events) {
      if (!isObj(ev) || typeof ev.e !== 'string' || !ev.e || ev.e.length > 40) continue;
      const line: Record<string, unknown> = { at, id, e: ev.e, t: finite(ev.t, at) };
      const p = cleanProps(ev.p);
      if (p) line.p = p;
      store.analytics.push(line);
    }
    return json(res, 200, { ok: true });
  }

  if (path === '/api/daily/submit' && method === 'POST') {
    const body = await readJson(req);
    if (!validBoardKey(body.key)) throw new HttpError(400, 'unknown or expired key');
    const crew = (Array.isArray(body.crew) ? body.crew : []).filter((n): n is string => isSafeName(n) || isBotName(n)).slice(0, 4);
    if (!crew.length) throw new HttpError(400, 'no valid crew names');
    const time = finite(body.time, NaN);
    if (!(time > 0)) throw new HttpError(400, 'bad time');
    const rank = store.submitRun(body.key, {
      crew,
      stars: Math.round(clamp(finite(body.stars), 0, 3)),
      time: Math.round(Math.min(time, 24 * 3600) * 10) / 10,
      damage: Math.round(clamp(finite(body.damage, 100), 0, 100)),
      at: Date.now(),
    });
    return json(res, 200, { ok: true, rank });
  }

  if (path === '/api/daily/board' && method === 'GET') {
    const key = query.get('key') ?? '';
    if (!/^[dw]\d{1,9}$/.test(key)) throw new HttpError(400, 'bad key');
    return json(res, 200, { entries: store.topRuns(key, 50) });
  }

  if (path === '/api/invites/credit' && method === 'POST') {
    const body = await readJson(req);
    if (!isHexId(body.ref) || !isHexId(body.id) || body.ref === body.id) throw new HttpError(400, 'bad ids');
    const credited = store.creditInvite(body.ref, body.id);
    return json(res, 200, { ok: true, credited });
  }

  const inv = /^\/api\/invites\/([^/]+)$/.exec(path);
  if (inv && method === 'GET') {
    const id = inv[1];
    if (!isHexId(id)) throw new HttpError(400, 'bad id');
    return json(res, 200, { friends: store.inviteCount(id) });
  }

  throw new HttpError(404, 'not found');
}

export async function handleApi(deps: ApiDeps, req: IncomingMessage, res: ServerResponse, url: URL) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS).end();
    return;
  }
  try {
    await handle(deps, req, res, url.pathname, url.searchParams);
  } catch (e) {
    if (res.headersSent) return;
    if (e instanceof HttpError) json(res, e.status, { ok: false, error: e.message });
    else {
      console.error('[api]', e);
      json(res, 500, { ok: false, error: 'server error' });
    }
  }
}
