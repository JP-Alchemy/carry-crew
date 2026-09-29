import { PROTOCOL_VERSION, type ClientMsg, type ServerMsg } from '../shared/protocol';
import { profile, totalStars } from './profile';

/** HTTP base of the game server, or null for an offline (static) build. */
export function serverBase(): string | null {
  const q = new URLSearchParams(location.search).get('server');
  if (q) return q.replace(/\/$/, '');
  const env = import.meta.env.VITE_SERVER_URL as string | undefined;
  if (env) return env.replace(/\/$/, '');
  if (location.protocol === 'file:') return null;
  return location.origin;
}

function wsUrl(base: string) {
  return base.replace(/^http/, 'ws') + '/ws';
}

type Handler = (m: ServerMsg) => void;

export class Net {
  private ws: WebSocket | null = null;
  private handlers = new Set<Handler>();
  id = '';
  closed = false;
  lastError = '';
  onClose?: () => void;

  async connect(timeoutMs = 4000): Promise<boolean> {
    const base = serverBase();
    if (!base) return false;
    return new Promise((resolve) => {
      let done = false;
      const finish = (ok: boolean) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(ok);
      };
      const timer = setTimeout(() => {
        this.ws?.close();
        finish(false);
      }, timeoutMs);
      try {
        this.ws = new WebSocket(wsUrl(base));
      } catch {
        finish(false);
        return;
      }
      this.ws.onopen = () => {
        const p = profile();
        this.send({ t: 'hello', v: PROTOCOL_VERSION, id: p.id, name: p.name, look: p.look, stars: totalStars() });
      };
      this.ws.onmessage = (ev) => {
        let m: ServerMsg;
        try {
          m = JSON.parse(ev.data as string);
        } catch {
          return;
        }
        if (m.t === 'welcome') {
          this.id = m.id;
          finish(true);
        } else if (m.t === 'error' && !this.id) {
          // e.g. "please refresh" on a protocol version mismatch
          this.lastError = m.msg;
        }
        this.handlers.forEach((h) => h(m));
      };
      this.ws.onerror = () => finish(false);
      this.ws.onclose = () => {
        this.closed = true;
        finish(false);
        this.onClose?.();
      };
    });
  }

  on(h: Handler) {
    this.handlers.add(h);
    return () => this.handlers.delete(h);
  }

  send(m: ClientMsg) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  close() {
    this.closed = true;
    this.onClose = undefined;
    this.ws?.close();
    this.ws = null;
    this.handlers.clear();
  }
}

export async function api<T>(path: string, body?: unknown): Promise<T | null> {
  const base = serverBase();
  if (!base) return null;
  try {
    const r = await fetch(base + path, body === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}
