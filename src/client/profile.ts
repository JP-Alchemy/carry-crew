import { COLOR_PRICE, DEFAULT_LOOK, HATS, ROPES, SHAPES, sanitizeLook } from '../shared/cosmetics';
import { randomName } from '../shared/names';
import type { Look } from '../shared/types';

export interface Profile {
  id: string;
  name: string;
  look: Look;
  coins: number;
  owned: { colors: number[]; shapes: number[]; hats: string[]; ropes: string[] };
  stars: Record<string, number>;
  best: Record<string, { time: number; damage: number }>;
  settings: { music: boolean; sfx: boolean; quality: 'low' | 'high'; seenHelp: boolean };
  firstPlay: number;
  lastPlay: number;
  sessions: number;
  invitedBy?: string;
  rewardsClaimed: string[];
  dailyDone: Record<string, number>;
}

const KEY = 'carrycrew.profile.v1';

function uid() {
  const a = new Uint8Array(8);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
}

function fresh(): Profile {
  return {
    id: uid(),
    name: randomName(),
    look: { ...DEFAULT_LOOK, body: Math.floor(Math.random() * 6) },
    coins: 0,
    owned: { colors: [0, 1, 2, 3, 4, 5], shapes: [0, 1], hats: ['none', 'party'], ropes: ['classic'] },
    stars: {},
    best: {},
    settings: { music: true, sfx: true, quality: 'high', seenHelp: false },
    firstPlay: Date.now(),
    lastPlay: Date.now(),
    sessions: 0,
    rewardsClaimed: [],
    dailyDone: {},
  };
}

let current: Profile | null = null;

export function profile(): Profile {
  if (current) return current;
  let p: Profile | null = null;
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) p = { ...fresh(), ...JSON.parse(raw) } as Profile;
  } catch {
    p = null;
  }
  current = p ?? fresh();
  current.look = sanitizeLook(current.look);
  return current;
}

export function saveProfile() {
  try {
    localStorage.setItem(KEY, JSON.stringify(profile()));
  } catch {
    /* private mode: keep going in memory */
  }
}

export function totalStars(p = profile()) {
  return Object.values(p.stars).reduce((a, b) => a + b, 0);
}

export function owns(kind: 'color' | 'shape' | 'hat' | 'rope', id: number | string, p = profile()) {
  if (kind === 'color') return p.owned.colors.includes(id as number);
  if (kind === 'shape') return p.owned.shapes.includes(id as number);
  if (kind === 'hat') return p.owned.hats.includes(id as string);
  return p.owned.ropes.includes(id as string);
}

export function priceOf(kind: 'color' | 'shape' | 'hat' | 'rope', id: number | string): number {
  if (kind === 'color') return COLOR_PRICE[id as number] ?? 0;
  if (kind === 'shape') return SHAPES.find((s) => s.id === id)?.price ?? 0;
  if (kind === 'hat') return HATS.find((h) => h.id === id)?.price ?? 0;
  return ROPES.find((r) => r.id === id)?.price ?? 0;
}

export function buy(kind: 'color' | 'shape' | 'hat' | 'rope', id: number | string): boolean {
  const p = profile();
  const price = priceOf(kind, id);
  if (owns(kind, id) ) return true;
  if (price < 0 || p.coins < price) return false;
  p.coins -= price;
  grant(kind, id);
  return true;
}

export function grant(kind: 'color' | 'shape' | 'hat' | 'rope', id: number | string) {
  const p = profile();
  if (owns(kind, id)) return;
  if (kind === 'color') p.owned.colors.push(id as number);
  else if (kind === 'shape') p.owned.shapes.push(id as number);
  else if (kind === 'hat') p.owned.hats.push(id as string);
  else p.owned.ropes.push(id as string);
  saveProfile();
}

/** Record a finished run; returns true if it's a new best for stars. */
export function recordRun(courseId: string, stars: number, time: number, damage: number, coins: number): boolean {
  const p = profile();
  const prev = p.stars[courseId] ?? 0;
  if (stars > prev) p.stars[courseId] = stars;
  const b = p.best[courseId];
  if (!b || time < b.time) p.best[courseId] = { time, damage };
  p.coins += coins;
  saveProfile();
  return stars > prev;
}
