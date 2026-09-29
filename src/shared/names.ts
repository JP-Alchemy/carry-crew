import { Rng } from './rng';

// No free-text names: every name is built from these word lists, so they're always safe to show.
export const ADJECTIVES = [
  'Wobbly', 'Sticky', 'Bouncy', 'Sleepy', 'Brave', 'Clumsy', 'Fluffy', 'Jolly', 'Speedy', 'Tiny',
  'Mighty', 'Giggly', 'Crumbly', 'Sneaky', 'Soggy', 'Sparkly', 'Wiggly', 'Zippy', 'Grumpy', 'Dizzy',
  'Frosty', 'Toasty', 'Lucky', 'Noodly', 'Squishy', 'Cosmic', 'Humble', 'Plucky', 'Snappy', 'Chunky',
] as const;

export const NOUNS = [
  'Muffin', 'Noodle', 'Pickle', 'Waffle', 'Sprout', 'Dumpling', 'Pebble', 'Button', 'Bean', 'Crumpet',
  'Nugget', 'Biscuit', 'Tadpole', 'Meatball', 'Marshmallow', 'Pancake', 'Teacup', 'Sock', 'Jellybean', 'Potato',
  'Otter', 'Penguin', 'Hamster', 'Goose', 'Llama', 'Panda', 'Walrus', 'Gecko', 'Badger', 'Puffin',
] as const;

export function randomName(seed = Math.floor(Math.random() * 1e9)): string {
  const r = new Rng(seed);
  return `${r.pick(ADJECTIVES)} ${r.pick(NOUNS)}`;
}

/** Only names made from the lists are accepted (server-side filter). */
export function isSafeName(name: unknown): name is string {
  if (typeof name !== 'string') return false;
  const parts = name.split(' ');
  return parts.length === 2 && (ADJECTIVES as readonly string[]).includes(parts[0]) && (NOUNS as readonly string[]).includes(parts[1]);
}

const BOT_NAMES = ['Botty', 'Bleep', 'Gizmo', 'Sprocket', 'Widget', 'Cog', 'Rivet', 'Blip'];
export function botName(i: number): string {
  return `${BOT_NAMES[i % BOT_NAMES.length]} (bot)`;
}
