import type { Look } from './types';

export const BODY_COLORS = [
  0xff6b6b, 0xffb84d, 0xffe066, 0x7bd389, 0x4dc3ff, 0x8c7bff, 0xff7bd1, 0xf2f2f2, 0x6b5b4d, 0x3ad6c5, 0xff4f9a, 0x9ad14d,
];
/** Colour index → coin price (the first six are free). */
export const COLOR_PRICE = [0, 0, 0, 0, 0, 0, 40, 40, 60, 60, 80, 80];

export const SHAPES = [
  { id: 0, name: 'Bean', price: 0 },
  { id: 1, name: 'Ball', price: 0 },
  { id: 2, name: 'Cube', price: 120 },
  { id: 3, name: 'Tall', price: 120 },
];

export const HATS = [
  { id: 'none', name: 'No hat', price: 0 },
  { id: 'party', name: 'Party hat', price: 0 },
  { id: 'chef', name: 'Chef hat', price: 60 },
  { id: 'beanie', name: 'Beanie', price: 60 },
  { id: 'propeller', name: 'Propeller cap', price: 120 },
  { id: 'bucket', name: 'Bucket', price: 90 },
  { id: 'crown', name: 'Crown', price: 250 },
  { id: 'cone', name: 'Traffic cone', price: 150 },
  { id: 'frog', name: 'Frog hat', price: 200 },
  { id: 'halo', name: 'Friendship halo', price: -1 }, // invite reward
];

export const ROPES = [
  { id: 'classic', name: 'Classic', price: 0, colors: [0xd9b77a, 0xc9a66b] },
  { id: 'candy', name: 'Candy cane', price: 80, colors: [0xffffff, 0xff3b3b] },
  { id: 'licorice', name: 'Licorice', price: 80, colors: [0x2b1b1b, 0xd9263b] },
  { id: 'rainbow', name: 'Rainbow', price: 200, colors: [0xff5252, 0xffa726, 0xffee58, 0x66bb6a, 0x42a5f5, 0xab47bc] },
  { id: 'chain', name: 'Toy chain', price: 150, colors: [0xb0bec5, 0x78909c] },
  { id: 'friendship', name: 'Friendship bracelet', price: -1, colors: [0xff80ab, 0x80d8ff, 0xccff90, 0xffe57f] },
];

export const DEFAULT_LOOK: Look = { body: 0, shape: 0, hat: 'party', rope: 'classic' };

export function sanitizeLook(l: Partial<Look> | undefined): Look {
  const body = Number.isInteger(l?.body) && l!.body! >= 0 && l!.body! < BODY_COLORS.length ? l!.body! : 0;
  const shape = Number.isInteger(l?.shape) && l!.shape! >= 0 && l!.shape! < SHAPES.length ? l!.shape! : 0;
  const hat = HATS.some((h) => h.id === l?.hat) ? l!.hat! : 'none';
  const rope = ROPES.some((r) => r.id === l?.rope) ? l!.rope! : 'classic';
  return { body, shape, hat, rope };
}

export const INVITE_REWARDS = [
  { friends: 1, kind: 'hat' as const, id: 'halo' },
  { friends: 3, kind: 'rope' as const, id: 'friendship' },
];
