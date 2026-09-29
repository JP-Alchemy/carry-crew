import { profile } from './profile';
import { serverBase } from './net';

// The metrics the portals judge us on: session start, first checkpoint, course complete,
// day-1 / day-7 return and crew size. Anonymous id only; no personal data.

type Props = Record<string, string | number | boolean>;
const queue: { e: string; t: number; p?: Props }[] = [];
let timer: number | null = null;

export function track(e: string, p?: Props) {
  queue.push({ e, t: Date.now(), p });
  if (import.meta.env.DEV) console.debug('[analytics]', e, p ?? '');
  if (timer === null) timer = window.setTimeout(flush, 4000);
}

function flush() {
  timer = null;
  if (!queue.length) return;
  const base = serverBase();
  if (!base) {
    queue.length = 0;
    return;
  }
  const events = queue.splice(0);
  const body = JSON.stringify({ id: profile().id, events });
  try {
    if (!navigator.sendBeacon?.(`${base}/api/events`, body)) void fetch(`${base}/api/events`, { method: 'POST', body, keepalive: true });
  } catch {
    /* offline is fine */
  }
}

window.addEventListener('pagehide', flush);

export function trackSessionStart() {
  const p = profile();
  const days = Math.floor((Date.now() - p.firstPlay) / 86400000);
  const lastDays = Math.floor((p.lastPlay - p.firstPlay) / 86400000);
  p.sessions++;
  track('session_start', { sessions: p.sessions, day: days });
  if (days >= 1 && days < 2 && lastDays < 1) track('return_d1');
  if (days >= 7 && days < 8 && lastDays < 7) track('return_d7');
  p.lastPlay = Date.now();
}
