import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { initPhysics } from '../shared/sim';
import { clientIp, handleApi } from './api';
import { Game } from './rooms';
import { serveStatic } from './static';
import { Store } from './store';
import { WindowLimiter } from './util';

/** Concurrent sockets allowed from one address (a school shares one address: keep it roomy). */
const MAX_SOCKETS_PER_IP = Number(process.env.MAX_SOCKETS_PER_IP ?? 32);

export interface ServerOptions {
  /** 0 picks a free port. Default: $PORT or 8787. */
  port?: number;
  host?: string;
  /** Where leaderboard/invite/analytics/report files live. Default: ./data */
  dataDir?: string;
  /** Built client. Default: ./dist/client */
  staticDir?: string;
  /** Quick-crew countdown. Default 10 s. */
  quickWaitMs?: number;
  /** Runs are force-ended after this long. Default 30 min. */
  maxRunMs?: number;
  /** Pause between delivery and results. Default 2.4 s. */
  resultDelayMs?: number;
  /** Per-IP, per-endpoint POST limit. Default 30/min. */
  postLimitPerMin?: number;
  /** Suppress per-room log lines. */
  quiet?: boolean;
}

export interface RunningServer {
  port: number;
  close(): Promise<void>;
}

export async function startServer(opts: ServerOptions = {}): Promise<RunningServer> {
  await initPhysics();
  const cwd = process.cwd();
  const store = new Store(resolve(cwd, opts.dataDir ?? 'data'));
  const staticDir = resolve(cwd, opts.staticDir ?? 'dist/client');
  const game = new Game(store, {
    quickWaitMs: opts.quickWaitMs ?? 10_000,
    maxRunMs: opts.maxRunMs ?? 30 * 60_000,
    resultDelayMs: opts.resultDelayMs ?? 2400,
    log: !opts.quiet,
  });
  const postLimiter = new WindowLimiter(opts.postLimitPerMin ?? 30, 60_000);
  const deps = { store, postLimiter, stats: () => ({ online: game.clients.size, rooms: game.rooms.size }) };

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) void handleApi(deps, req, res, url);
    else serveStatic(staticDir, req, res, url.pathname);
  });
  server.keepAliveTimeout = 10_000;

  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096, perMessageDeflate: false });
  const alive = new WeakMap<WebSocket, boolean>();
  const perIp = new Map<string, number>();
  server.on('upgrade', (req, socket, head) => {
    let path = '';
    try {
      path = new URL(req.url ?? '/', 'http://localhost').pathname;
    } catch {
      /* fall through */
    }
    if (path !== '/ws') {
      socket.destroy();
      return;
    }
    // A handful of tabs per address is plenty; more is someone trying to spin up simulations.
    const ip = clientIp(req);
    if ((perIp.get(ip) ?? 0) >= MAX_SOCKETS_PER_IP) {
      socket.write('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      perIp.set(ip, (perIp.get(ip) ?? 0) + 1);
      ws.once('close', () => {
        const n = (perIp.get(ip) ?? 1) - 1;
        if (n <= 0) perIp.delete(ip);
        else perIp.set(ip, n);
      });
      alive.set(ws, true);
      ws.on('pong', () => alive.set(ws, true));
      game.accept(ws, clientIp(req));
    });
  });

  // Drop dead connections (their seats go to bots) and tidy the rate-limit table.
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.get(ws)) {
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      ws.ping();
    }
    postLimiter.sweep();
  }, 30_000);
  heartbeat.unref();

  const port = await new Promise<number>((res, rej) => {
    server.once('error', rej);
    server.listen(opts.port ?? Number(process.env.PORT ?? 8787), opts.host, () => {
      server.off('error', rej);
      res((server.address() as AddressInfo).port);
    });
  });

  let closing: Promise<void> | null = null;
  const close = () =>
    (closing ??= (async () => {
      clearInterval(heartbeat);
      game.stop();
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      await new Promise<void>((r) => {
        server.close(() => r());
        server.closeAllConnections();
      });
      await store.flush();
    })());

  return { port, close };
}
