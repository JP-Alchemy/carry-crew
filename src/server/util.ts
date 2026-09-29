import { randomBytes, randomInt } from 'node:crypto';
import { botName, isSafeName, randomName } from '../shared/names';

export const HEX16 = /^[0-9a-f]{16}$/;

export function newId(): string {
  return randomBytes(8).toString('hex');
}

export function isHexId(v: unknown): v is string {
  return typeof v === 'string' && HEX16.test(v);
}

export function safeRandomName(): string {
  // randomName() only ever draws from the safe word lists, but double-check anyway.
  for (let i = 0; i < 5; i++) {
    const n = randomName(randomInt(1e9));
    if (isSafeName(n)) return n;
  }
  return 'Wobbly Muffin';
}

const BOT_NAMES = new Set(Array.from({ length: 8 }, (_, i) => botName(i)));
/** A name that botName() could have produced. */
export function isBotName(v: unknown): v is string {
  return typeof v === 'string' && BOT_NAMES.has(v);
}

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

export function finite(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

export function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Classic token bucket: `cap` burst, refilled at `rate` tokens per second. */
export class Bucket {
  private tokens: number;
  private last: number;
  constructor(
    private cap: number,
    private rate: number,
  ) {
    this.tokens = cap;
    this.last = Date.now();
  }
  take(n = 1): boolean {
    const now = Date.now();
    this.tokens = Math.min(this.cap, this.tokens + ((now - this.last) / 1000) * this.rate);
    this.last = now;
    if (this.tokens < n) return false;
    this.tokens -= n;
    return true;
  }
}

/** Fixed-window counter per key (used for per-IP HTTP rate limits). */
export class WindowLimiter {
  private hits = new Map<string, { n: number; reset: number }>();
  constructor(
    private limit: number,
    private windowMs: number,
  ) {}
  allow(key: string): boolean {
    const now = Date.now();
    let h = this.hits.get(key);
    if (!h || now >= h.reset) {
      h = { n: 0, reset: now + this.windowMs };
      this.hits.set(key, h);
    }
    h.n++;
    return h.n <= this.limit;
  }
  sweep() {
    const now = Date.now();
    for (const [k, h] of this.hits) if (now >= h.reset) this.hits.delete(k);
  }
}
