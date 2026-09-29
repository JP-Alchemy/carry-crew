import { Rng, hashString } from './rng';
import type {
  BiomeId,
  BotHint,
  CargoKind,
  Checkpoint,
  CourseDef,
  CourseSpec,
  Decor,
  Mover,
  MoverPath,
  Prop,
  Solid,
  Twist,
  Zone,
  ZoneKind,
} from './types';

// A course is a chain of hand-made pieces. Each piece is drawn in local coordinates where x=0 is the
// piece's left edge and y=0 is the surface height the crew enters on. Every piece starts a checkpoint.

interface PieceOut {
  w: number;
  exitY?: number;
  par: number;
}

type Piece = (b: Builder, d: number, rng: Rng) => PieceOut;

class Builder {
  ox = 0;
  oy = 0;
  floorY: number;
  baseMat: string;
  solids: Solid[] = [];
  zones: Zone[] = [];
  movers: Mover[] = [];
  props: Prop[] = [];
  coins: { x: number; y: number }[] = [];
  hints: BotHint[] = [];
  decor: Decor[] = [];
  cargoStart = { x: 0, y: 0 };
  goal = { x: 0, y: 0, w: 0, h: 0 };
  maxTop = 0;

  constructor(floorY: number, baseMat: string) {
    this.floorY = floorY;
    this.baseMat = baseMat;
  }

  private track(top: number) {
    this.maxTop = Math.max(this.maxTop, top);
  }

  /** Box by left edge and top surface (local coords). */
  box(x: number, top: number, w: number, h: number, mat: string, extra: Partial<Solid> = {}) {
    const s: Solid = { x: this.ox + x + w / 2, y: this.oy + top - h / 2, w, h, mat, ...extra };
    this.solids.push(s);
    this.track(this.oy + top);
    return s;
  }
  /** Box sitting on a surface: centre x, bottom y. */
  block(cx: number, bottom: number, w: number, h: number, mat: string, extra: Partial<Solid> = {}) {
    return this.box(cx - w / 2, bottom + h, w, h, mat, extra);
  }
  /** Ground slab from a local top surface all the way down to the floor. */
  ground(x: number, w: number, top = 0, mat = this.baseMat, extra: Partial<Solid> = {}) {
    const h = this.oy + top - this.floorY;
    return this.box(x, top, w, h, mat, extra);
  }
  /** Thin plank between two local points (its top surface runs along the line). */
  plank(x1: number, y1: number, x2: number, y2: number, thick: number, mat: string, extra: Partial<Solid> = {}) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy);
    const a = Math.atan2(dy, dx);
    const nx = -Math.sin(a) * (thick / 2);
    const ny = Math.cos(a) * (thick / 2);
    const s: Solid = { x: this.ox + (x1 + x2) / 2 - nx, y: this.oy + (y1 + y2) / 2 - ny, w: len, h: thick, a, mat, ...extra };
    this.solids.push(s);
    this.track(this.oy + Math.max(y1, y2));
    return s;
  }
  ball(cx: number, cy: number, d: number, mat: string) {
    this.solids.push({ x: this.ox + cx, y: this.oy + cy, w: d, h: d, round: true, mat });
  }
  zone(kind: ZoneKind, x: number, bottom: number, w: number, h: number, extra: Partial<Zone> = {}) {
    this.zones.push({ kind, x: this.ox + x + w / 2, y: this.oy + bottom + h / 2, w, h, ...extra });
  }
  mover(m: Mover) {
    const p = m.path;
    const o = (x: number, y: number) => [this.ox + x, this.oy + y];
    let path: MoverPath;
    switch (p.type) {
      case 'line': {
        const [ax, ay] = o(p.ax, p.ay);
        const [bx, by] = o(p.bx, p.by);
        path = { ...p, ax, ay, bx, by };
        break;
      }
      case 'pendulum': {
        const [px, py] = o(p.px, p.py);
        path = { ...p, px, py };
        break;
      }
      default: {
        const [x, y] = o(p.x, p.y);
        path = { ...p, x, y };
      }
    }
    this.movers.push({ ...m, path });
  }
  prop(p: Prop) {
    this.props.push({ ...p, x: this.ox + p.x, y: this.oy + p.y });
  }
  coin(x: number, y: number) {
    this.coins.push({ x: this.ox + x, y: this.oy + y });
  }
  hint(x: number, a: BotHint['a']) {
    this.hints.push({ x: this.ox + x, a });
  }
  deco(kind: string, x: number, y: number, z: number, s = 1, extra: Partial<Decor> = {}) {
    this.decor.push({ kind, x: this.ox + x, y: this.oy + y, z, s, ...extra });
  }
  cargoAt(x: number, y: number) {
    this.cargoStart = { x: this.ox + x, y: this.oy + y };
  }
  goalAt(x: number, bottom: number, w: number, h: number) {
    this.goal = { x: this.ox + x + w / 2, y: this.oy + bottom + h / 2, w, h };
  }
}

// ------------------------------------------------------------------------------------------------
// Kitchen: counters are cliffs, the floor is the abyss.

const kStart: Piece = (b) => {
  b.ground(0, 12);
  b.deco('window', 6, 4.2, -3.2, 1);
  b.deco('kettle', 1.6, 0, -1.3, 1.1);
  b.deco('jar', 3.4, 0, -1.6, 0.8, { c: 0xe8a33b });
  b.deco('jar', 4.4, 0, -1.7, 0.6, { c: 0xc85a3a });
  b.deco('cabinet', 6, 6.5, -3.4, 1);
  b.deco('sign', 9.4, 1.6, -1.2, 1, { text: 'CARRY →' });
  b.cargoAt(7.6, 0);
  return { w: 12, par: 12 };
};

const kJars: Piece = (b, d) => {
  b.ground(0, 16);
  b.block(4, 0, 1.1, 0.6 + 0.12 * d, 'jar', { tag: 'honey' });
  b.block(8.5, 0, 1.9, 0.45, 'box', { tag: 'cereal' });
  b.block(12.5, 0, 1.0, 0.75 + 0.12 * d, 'jar', { tag: 'jam' });
  b.coin(8.5, 2.5);
  b.hint(2.8, 'jump');
  b.hint(7.2, 'jump');
  b.hint(11.3, 'jump');
  b.deco('cabinet', 8, 6.5, -3.4, 1);
  b.deco('utensils', 14.5, 0, -1.5, 1);
  return { w: 16, par: 28 };
};

const kStove: Piece = (b, d) => {
  b.ground(0, 3);
  b.ground(3, 12, 0, 'stove');
  // Burners flicker in a "green wave": walk at carrying pace and you catch each one off.
  const burners = d >= 1 ? [4.2, 7.6, 11] : [5, 10];
  burners.forEach((x, i) => {
    b.zone('heat', x, 0, 2, 0.55, { period: 4.4, duty: d >= 2 ? 0.55 : 0.5, phase: -((x - burners[0]) / 3.3) - i * 0.2, tag: 'burner' });
    b.hint(x - 0.9, 'wait');
  });
  b.coin(burners[1] + 1, 2.3);
  b.ground(15, 3);
  b.deco('hood', 9, 6.2, -2.6, 1);
  b.deco('pan', 13.6, 0, -1.4, 1);
  return { w: 18, par: 32 };
};

const kSink: Piece = (b, d) => {
  b.ground(0, 4);
  b.ground(10, 6);
  b.ground(4, 6, -2.7, 'metal', { tag: 'sinkbottom' });
  b.zone('kill', 4, -2.7, 6, 0.8, { tag: 'sinkwater' });
  // A dish rack bridges the sink; harder versions have a gap to hop.
  if (d === 0) b.box(3.8, -0.25, 6.4, 0.22, 'rack');
  else {
    const gap = d >= 2 ? 1.0 : 0.8;
    b.box(3.8, -0.25, 3.2 - gap / 2, 0.22, 'rack');
    b.box(7 + gap / 2, -0.25, 3.2 - gap / 2, 0.22, 'rack');
    b.hint(6.7 - gap / 2, 'gap');
  }
  b.deco('rack', 7, -2.7, 0, 1);
  b.deco('tap', 7.4, 0, -0.7, 1);
  b.zone('water', 6.9, -2, 1, 5.2, { fy: -34, period: 6, duty: 0.4, tag: 'tap' });
  b.hint(3.5, 'wait');
  b.coin(7.4, -1.2);
  b.deco('window', 7, 4.4, -3.2, 1.1);
  return { w: 16, par: 30 };
};

const kBooks: Piece = (b, d) => {
  b.ground(0, 14);
  b.box(2.5, 0.6, 9.5, 0.6, 'book');
  b.box(4, 1.2, 6.5, 0.6, 'book');
  const top = d >= 1 ? 2.1 : 1.8;
  b.box(5.4, top, 3.4, top - 1.2, 'book');
  b.coin(7.1, top + 1.3);
  b.hint(2, 'jump');
  b.hint(3.5, 'jump');
  b.hint(4.9, 'jump');
  b.deco('cabinet', 7, 6.5, -3.4, 1);
  b.deco('plant', 12.5, 0, -1.4, 1);
  return { w: 14, par: 30 };
};

const kCat: Piece = (b, d) => {
  b.ground(0, 17);
  b.block(6, 0, 1.5, 0.7, 'toaster');
  b.deco('cat', 15.6, 0, -1.6, 1);
  b.mover({
    kind: 'paw',
    w: 1.7,
    h: 0.7,
    mat: 'fur',
    path: { type: 'line', ax: 13.8, ay: 2.7, bx: 8.8, by: 0.42, period: d >= 2 ? 5 : d === 1 ? 5.4 : 6, profile: 'swipe' },
    knock: { x: -6, y: 5, damage: 14 },
  });
  b.hint(4.9, 'wait');
  b.hint(4.95, 'jump');
  b.coin(6, 2.2);
  return { w: 17, par: 30 };
};

const kSpoon: Piece = (b, d) => {
  b.ground(0, 4);
  b.ground(10, 4);
  if (d === 0) {
    b.plank(3.6, 0, 10.4, 0, 0.26, 'spoon');
  } else {
    b.prop({ kind: 'seesaw', x: 7, y: 0.02, w: 5.8, h: 0.26, mass: 1.6, mat: 'board' });
    b.deco('rollingpin', 7, -0.9, 0, 1);
    b.hint(3.4, 'jump');
    b.hint(9.6, 'jump');
  }
  b.coin(7, 1.6);
  b.deco('cabinet', 7, 6.5, -3.4, 1);
  return { w: 14, par: 26 };
};

const kCereal: Piece = (b, d) => {
  b.ground(0, 16);
  const rows = d >= 1 ? 4 : 3;
  const s = 0.55;
  for (let r = 0; r < rows; r++) {
    for (let i = 0; i < rows - r; i++) {
      b.prop({ kind: 'block', x: 6 + (i - (rows - r - 1) / 2) * (s + 0.02), y: s / 2 + r * s + 0.01, w: s, h: s, mass: 0.25, mat: 'sugar' });
    }
  }
  b.plank(10.5, 0, 13, 0.8, 0.22, 'board');
  b.box(13, 0.8, 2.2, 0.8, 'box', { tag: 'cereal' });
  b.hint(4.4, 'jump');
  b.hint(12.6, 'jump');
  b.coin(14, 2.2);
  b.deco('cabinet', 8, 6.5, -3.4, 1);
  return { w: 16, par: 26 };
};

const kGoal: Piece = (b) => {
  b.ground(0, 4);
  b.box(4, 0, 12, 0.45, 'table');
  b.deco('tableleg', 5, -0.45, 0, 1);
  b.deco('tableleg', 15.3, -0.45, 0, 1);
  b.goalAt(9, 0, 4, 2.2);
  b.deco('cakestand', 11, 0, 0, 1);
  b.deco('balloons', 6.2, 0, -1.6, 1, { c: 0xff5a7a });
  b.deco('balloons', 14.6, 0, -1.8, 1.1, { c: 0x5ab0ff });
  b.deco('banner', 11, 5.2, -2.4, 1, { text: 'HAPPY BIRTHDAY' });
  b.deco('partyhat', 13.8, 0, -0.8, 1);
  b.deco('partyhat', 7.5, 0, -0.9, 0.8);
  return { w: 16, par: 16 };
};

// ------------------------------------------------------------------------------------------------
// Bedroom: desk, bed and toy shelves.

const bStart: Piece = (b) => {
  b.baseMat = 'desk';
  b.ground(0, 12);
  b.deco('lamp', 1.8, 0, -1.4, 1);
  b.deco('pencils', 4, 0, -1.4, 1);
  b.deco('poster', 7, 4.5, -3.2, 1, { text: '★' });
  b.deco('window', 10.5, 4.8, -3.3, 1);
  b.cargoAt(7.6, 0);
  return { w: 12, par: 12 };
};

const bBooks: Piece = (b, d) => {
  b.ground(0, 14);
  const hs = d >= 1 ? [0.55, 1.1, 1.8, 1.1, 0.55] : [0.5, 1.0, 1.5, 1.0, 0.5];
  hs.forEach((h, i) => b.block(3 + i * 1.8, 0, 1.8, h, 'book'));
  hs.forEach((_, i) => i < 3 && b.hint(2 + i * 1.8, 'jump'));
  b.coin(6.6, 3.3);
  b.deco('globe', 12.6, 0, -1.4, 1);
  return { w: 14, par: 28 };
};

const bBlocks: Piece = (b, d) => {
  b.ground(0, 14);
  const s = 0.62;
  const cols = d >= 1 ? 3 : 2;
  const rows = d >= 2 ? 3 : 2;
  for (let c = 0; c < cols; c++)
    for (let r = 0; r < rows; r++)
      b.prop({ kind: 'block', x: 6.4 + c * (s + 0.02), y: s / 2 + r * s + 0.01, w: s, h: s, mass: 0.15, mat: 'toyblock' });
  b.block(11.2, 0, 1.2, 0.6, 'toyblock');
  b.hint(5.4, 'jump');
  b.coin(7, 3.5);
  b.deco('teddy', 12.8, 0, -1.5, 1);
  return { w: 14, par: 26 };
};

const bCar: Piece = (b, d) => {
  b.ground(0, 16);
  // A book bridge over the toy-car lane. Fall through the gap and the car bowls you over.
  b.block(2.4, 0, 1.2, 0.5, 'toyblock');
  const gap = d >= 2 ? 0.9 : d === 1 ? 0.8 : 0.7;
  // Open at both ends, so anyone who falls in can walk out (if the car lets them).
  b.box(3, 1.0, 4.6 - gap / 2, 0.18, 'shelf');
  b.box(7.6 + gap / 2, 1.0, 5.6 - gap / 2, 0.18, 'shelf');
  b.deco('shelfleg', 3.2, 0, 0.55, 1);
  b.deco('shelfleg', 13, 0, 0.55, 1);
  b.mover({
    kind: 'car',
    w: 1.6,
    h: 0.7,
    mat: 'toycar',
    path: { type: 'line', ax: 5.4, ay: 0.36, bx: 10.6, by: 0.36, period: d >= 1 ? 3.6 : 4.6, profile: 'pingpong' },
    knock: { x: 5, y: 4.5, damage: 12 },
    botIgnore: true,
  });
  b.hint(1.5, 'jump');
  b.hint(2.7, 'jump');
  b.hint(7.5 - gap / 2, 'gap');
  b.coin(7.6, 0.6);
  b.deco('track', 8, 0, -0.4, 1);
  b.deco('poster', 8, 4.6, -3.2, 1, { text: 'VROOM' });
  return { w: 16, par: 26 };
};

const bBed: Piece = (b, d) => {
  b.ground(0, 3.5);
  b.baseMat = 'bed';
  b.ground(3.5, 12.5, -1.2, 'bed', { bounce: 0.55, friction: 0.9 });
  b.prop({ kind: 'pillow', x: 8, y: -0.75, w: 2.4, h: 0.8, mass: 0.5, mat: 'pillow' });
  if (d >= 1) b.prop({ kind: 'pillow', x: 12.4, y: -0.75, w: 2.2, h: 0.8, mass: 0.5, mat: 'pillow' });
  b.deco('headboard', 5.2, -1.2, -0.6, 1);
  b.deco('window', 10, 4.2, -3.3, 1);
  b.hint(3, 'jump');
  b.coin(4, 1.2);
  return { w: 16, exitY: -1.2, par: 22 };
};

const bDog: Piece = (b, d) => {
  b.ground(0, 16, 0, 'bed', { bounce: 0.55, friction: 0.9 });
  b.mover({ kind: 'dog', w: 4.6, h: 0.7, mat: 'dogfur', path: { type: 'breathe', x: 8, y: 0.35, amp: 0.22, period: 3.2 } });
  b.deco('doghead', 11, 0, -0.5, 0.85);
  b.zone('wind', 5.5, 0, 6.5, 3.2, { fx: d >= 1 ? -20 : -15, fy: 3, period: 5, duty: d >= 1 ? 0.4 : 0.3, phase: 1, tag: 'snore' });
  b.hint(5.2, 'wait');
  b.hint(5.3, 'jump');
  b.coin(8, 2.8);
  return { w: 16, par: 26 };
};

const bFan: Piece = (b, d) => {
  b.ground(0, 16, 0, b.baseMat, b.baseMat === 'bed' ? { bounce: 0.55, friction: 0.9 } : {});
  b.deco('fan', 15.5, 0, -0.8, 1.3);
  b.zone('wind', 2, 0, 12, 4, { fx: d >= 2 ? -20 : d === 1 ? -15 : -11, period: 7, duty: 0.5, tag: 'fan' });
  b.block(6, 0, 1, 0.45, 'toyblock');
  b.block(10, 0, 1, 0.45, 'toyblock');
  b.hint(5, 'jump');
  b.hint(9, 'jump');
  b.coin(8, 2);
  return { w: 16, par: 26 };
};

const bShelf: Piece = (b, d) => {
  b.ground(0, 3.5, 0, b.baseMat);
  b.baseMat = 'shelf';
  const step = d >= 2 ? 0.9 : d === 1 ? 0.85 : 0.8;
  b.ground(3.5, 3, step, 'shelf');
  b.ground(6.5, 3, step * 2, 'shelf');
  b.ground(9.5, 4.5, step * 3, 'shelf');
  b.box(3.5, step * 2 + 1.6, 2.5, 0.25, 'shelf');
  b.coin(4.7, step * 2 + 2.3);
  b.deco('toyrobot', 4.4, step, -0.6, 0.9);
  b.deco('shelfback', 8, 0, -1.2, 1);
  b.hint(3.2, 'jump');
  b.hint(6.2, 'jump');
  b.hint(9.2, 'jump');
  return { w: 14, exitY: step * 3, par: 30 };
};

const bGoal: Piece = (b) => {
  b.ground(0, 16, 0, b.baseMat);
  b.goalAt(8.5, 0, 4, 2.4);
  b.deco('aquarium', 10.5, 0, -0.9, 1);
  b.deco('fishsign', 10.5, 3.4, -1.2, 1, { text: 'NEW HOME' });
  b.deco('lamp', 14.5, 0, -1.4, 1);
  return { w: 16, par: 16 };
};

// ------------------------------------------------------------------------------------------------
// Playground: grass, puddles, and big equipment.

const pStart: Piece = (b) => {
  b.baseMat = 'grass';
  b.ground(0, 12);
  b.deco('tree', 2, 0, -4.5, 1.4);
  b.deco('fence', 8, 0, -2.5, 1);
  b.deco('sign', 9.4, 1.6, -1.2, 1, { text: 'GRANDMA →' });
  b.cargoAt(7.6, 0);
  return { w: 12, par: 12 };
};

const pSand: Piece = (b) => {
  b.ground(0, 3);
  b.ground(3, 10, -0.3, 'sand');
  b.zone('sand', 3, -0.3, 10, 1.2);
  b.block(6, -0.3, 0.9, 0.75, 'bucket');
  b.ground(13, 3);
  b.hint(5.1, 'jump');
  b.hint(12.6, 'jump');
  b.coin(6, 2.4);
  b.deco('spade', 11.5, -0.3, -0.8, 1);
  return { w: 16, par: 28 };
};

const pSlide: Piece = (b, d) => {
  b.ground(0, 16);
  // Climb the steps, then ride the slide down (it's slippery: hold on to that vase!).
  const rise = d >= 1 ? 0.62 : 0.55;
  const steps = 4;
  for (let i = 1; i <= steps; i++) b.box(1.2 + i * 1.1, rise * i, 1.1, rise * i, 'wood', { tag: 'step' });
  const top = rise * steps;
  const sx = 1.2 + (steps + 1) * 1.1;
  b.box(sx, top, 1.4, top, 'wood');
  b.plank(sx + 1.4, top, 15.4, 0.1, 0.3, 'slide', { friction: 0.08 });
  for (let i = 1; i <= steps; i++) b.hint(1.2 + i * 1.1 - 0.35, 'jump');
  b.coin(sx + 0.7, top + 1.5);
  b.deco('slideframe', sx + 0.7, 0, -0.9, 1);
  return { w: 16, par: 30 };
};

const pSwings: Piece = (b, d) => {
  b.ground(0, 3);
  b.ground(15, 3);
  b.ground(3, 12, -2.2, 'mud');
  b.zone('kill', 3, -2.2, 12, 0.7, { tag: 'puddle' });
  // A rickety bridge over the puddle, right under the swings. Time your crossing!
  const gap = d >= 1 ? 0.8 : 0.55;
  b.box(3, -0.25, 3.8 - gap / 2, 0.2, 'wood');
  b.box(6.8 + gap / 2, -0.25, 4 - gap, 0.2, 'wood');
  b.box(10.8 + gap / 2, -0.25, 4.2 - gap / 2, 0.2, 'wood');
  const xs = [5.2, 9, 12.8];
  xs.forEach((x, i) =>
    b.mover({
      kind: 'swing',
      w: 1.6,
      h: 0.22,
      mat: 'rubber',
      path: { type: 'pendulum', px: x, py: 6.6, len: 5.0, amp: d >= 1 ? 0.3 : 0.22, period: 3.6, phase: i * 0.33 },
    }),
  );
  b.deco('swingframe', 9, 0, -0.4, 1);
  b.hint(6.8 - gap / 2 - 0.1, 'gap');
  b.hint(10.8 - gap / 2 - 0.1, 'gap');
  b.coin(9, 2.2);
  return { w: 18, par: 34 };
};

const pFootball: Piece = (b, d) => {
  b.ground(0, 18);
  b.prop({ kind: 'ball', x: 15, y: 0.55, w: 1.1, h: 1.1, mass: 0.5, mat: 'football', kick: { period: d >= 1 ? 3.5 : 4.5, x: -8.5, y: 6 } });
  b.deco('goalpost', 1.2, 0, -1.6, 1);
  b.deco('goalpost', 16.8, 0, -1.6, 1);
  b.block(8.5, 0, 1.6, 0.5, 'bench');
  b.hint(7.4, 'jump');
  b.coin(8.5, 2.3);
  return { w: 18, par: 26 };
};

const pFrame: Piece = (b, d) => {
  b.ground(0, 3);
  // Climbing frame over a mud puddle: up the platforms and down the other side.
  const hi = d >= 2 ? 1.8 : 1.5;
  const gap = d >= 2 ? 0.7 : d === 1 ? 0.55 : 0.4;
  b.box(2.2, 0.55, 0.9, 0.3, 'wood');
  b.box(3.1, 1.0, 3.3, 0.3, 'wood');
  b.box(6.4 + gap, hi, 3.6 - gap, 0.3, 'wood');
  b.box(10 + gap, 1.0, 3.3 - gap, 0.3, 'wood');
  b.box(13.3, 0.55, 0.9, 0.3, 'wood');
  b.ground(3.1, 11, -1.6, 'mud');
  b.zone('kill', 3.1, -1.6, 11, 0.6, { tag: 'puddle' });
  b.ground(14, 3);
  b.deco('frame', 8.5, 0, -0.5, 1, { s: hi });
  b.hint(1.8, 'jump');
  b.hint(2.8, 'jump');
  b.hint(6.2, 'jump');
  b.hint(6.3, 'gap');
  b.hint(9.95, 'gap');
  b.coin(8.3, hi + 1.4);
  return { w: 17, par: 34 };
};

const pWind: Piece = (b, d) => {
  b.ground(0, 16);
  b.block(5, 0, 1.2, 0.4, 'toyblock');
  b.block(11, 0, 1.2, 0.4, 'toyblock');
  b.zone('wind', 0, 0, 16, 5, { fx: d >= 1 ? -20 : -14, fy: 2, period: 6.5, duty: 0.45, tag: 'gust' });
  b.hint(4, 'jump');
  b.hint(10, 'jump');
  b.coin(8, 2.5);
  b.deco('tree', 13, 0, -3.8, 1.2);
  b.deco('bench', 8, 0, -1.4, 1);
  return { w: 16, par: 24 };
};

const pSeesaw: Piece = (b) => {
  b.ground(0, 4);
  b.ground(11, 4);
  b.ground(4, 7, -1.4, 'mud');
  b.zone('kill', 4, -1.4, 7, 0.6, { tag: 'puddle' });
  b.prop({ kind: 'seesaw', x: 7.5, y: 0.02, w: 6.6, h: 0.28, mass: 1.8, mat: 'wood' });
  b.hint(3.4, 'jump');
  b.hint(10.6, 'jump');
  b.deco('seesawbase', 7.5, -1.4, 0, 1);
  b.coin(7.5, 1.8);
  return { w: 15, par: 24 };
};

const pGoal: Piece = (b) => {
  b.ground(0, 16);
  b.box(8, 1, 7, 0.3, 'bench');
  b.box(7, 0.5, 1, 0.5, 'wood');
  b.deco('benchlegs', 11.5, 0, 0, 1);
  b.goalAt(8.2, 1, 3.4, 2.4);
  b.deco('grandma', 13.2, 1, -0.3, 1);
  b.deco('tree', 11, 0, -4, 1.5);
  b.hint(6.2, 'jump');
  b.hint(7.6, 'jump');
  return { w: 16, par: 18 };
};

// ------------------------------------------------------------------------------------------------

interface BiomeInfo {
  id: BiomeId;
  name: string;
  cargo: CargoKind;
  scene: CourseDef['scene'];
  floorY: number;
  baseMat: string;
  start: Piece;
  goal: Piece;
  pool: Piece[];
  courses: { name: string; d: number; pieces: Piece[] }[];
}

export const BIOMES: Record<BiomeId, BiomeInfo> = {
  kitchen: {
    id: 'kitchen',
    name: 'Kitchen',
    cargo: 'cake',
    scene: 'party',
    floorY: -7,
    baseMat: 'counter',
    start: kStart,
    goal: kGoal,
    pool: [kJars, kStove, kSink, kBooks, kCat, kSpoon, kCereal],
    courses: [
      { name: 'Cake Walk', d: 0, pieces: [kJars, kStove, kBooks, kSink, kCat] },
      { name: 'Hot Stuff', d: 1, pieces: [kJars, kSpoon, kStove, kCereal, kSink, kBooks, kCat] },
      { name: 'Kitchen Nightmare', d: 2, pieces: [kCereal, kCat, kStove, kSpoon, kSink, kBooks, kJars, kStove, kCat] },
    ],
  },
  bedroom: {
    id: 'bedroom',
    name: "Kid's Bedroom",
    cargo: 'fishtank',
    scene: 'aquarium',
    floorY: -7,
    baseMat: 'desk',
    start: bStart,
    goal: bGoal,
    pool: [bBooks, bBlocks, bCar, bBed, bDog, bFan, bShelf],
    courses: [
      { name: 'Tank Top', d: 0, pieces: [bBooks, bBlocks, bCar, bBed, bDog, bShelf] },
      { name: 'Sleeping Dogs', d: 1, pieces: [bCar, bBooks, bBlocks, bBed, bFan, bDog, bShelf] },
      { name: 'Fish Out of Water', d: 2, pieces: [bBlocks, bCar, bBooks, bFan, bBed, bDog, bFan, bShelf, bBlocks] },
    ],
  },
  playground: {
    id: 'playground',
    name: 'Playground',
    cargo: 'vase',
    scene: 'grandma',
    floorY: -3,
    baseMat: 'grass',
    start: pStart,
    goal: pGoal,
    pool: [pSand, pSlide, pSwings, pFootball, pFrame, pWind, pSeesaw],
    courses: [
      { name: "Grandma's Vase", d: 0, pieces: [pSand, pSlide, pFootball, pSeesaw, pFrame] },
      { name: 'Swing Low', d: 1, pieces: [pSand, pFootball, pSwings, pSlide, pWind, pFrame] },
      { name: 'Recess Chaos', d: 2, pieces: [pWind, pSlide, pSwings, pFootball, pSeesaw, pFrame, pSand, pSwings] },
    ],
  },
};

export const BIOME_ORDER: BiomeId[] = ['kitchen', 'bedroom', 'playground'];

export const NO_TWIST: Twist = { id: 'none', label: 'Classic', gravity: 1, cargoMass: 1, ropeLen: 1 };

export const TWISTS: Twist[] = [
  { id: 'moon', label: 'Low gravity', gravity: 0.6, cargoMass: 1, ropeLen: 1 },
  { id: 'heavy', label: 'Heavy cargo', gravity: 1, cargoMass: 1.8, ropeLen: 1 },
  { id: 'short', label: 'Short rope', gravity: 1, cargoMass: 1, ropeLen: 0.65 },
  { id: 'long', label: 'Extra-long rope', gravity: 1, cargoMass: 1, ropeLen: 1.5 },
  { id: 'plates', label: 'Stack of plates', gravity: 1, cargoMass: 1, ropeLen: 1, cargo: 'plates' },
  { id: 'glass', label: 'Extra fragile', gravity: 1, cargoMass: 1, ropeLen: 1, fragile: 1.8 },
];

export function courseId(spec: CourseSpec): string {
  if (spec.index >= 0) return `${spec.biome}-${spec.index + 1}`;
  return `${spec.index === -1 ? 'daily' : 'weekly'}-${spec.seed ?? 0}`;
}

export function courseName(spec: CourseSpec): string {
  if (spec.index >= 0) return BIOMES[spec.biome].courses[spec.index].name;
  return spec.label ?? (spec.index === -1 ? 'Daily Course' : 'Weekly Challenge');
}

/** YYYYMMDD in UTC, used as the daily seed so everyone gets the same course on the same day. */
export function dayKey(date = new Date()): number {
  return date.getUTCFullYear() * 10000 + (date.getUTCMonth() + 1) * 100 + date.getUTCDate();
}

export function weekKey(date = new Date()): number {
  const t = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  const monday = t - ((new Date(t).getUTCDay() + 6) % 7) * 86400000;
  return Math.floor(monday / 86400000);
}

export function dailySpec(date = new Date()): CourseSpec {
  const seed = dayKey(date);
  const rng = new Rng(hashString('daily' + seed));
  return { biome: rng.pick(BIOME_ORDER), index: -1, seed, label: 'Daily Course' };
}

export function weeklySpec(date = new Date()): CourseSpec {
  const seed = weekKey(date);
  const rng = new Rng(hashString('weekly' + seed));
  return { biome: rng.pick(BIOME_ORDER), index: -2, seed, label: 'Weekly Challenge' };
}

/** Test helper: a course of [start, ...named pieces, goal] at a given difficulty. */
export function buildTestCourse(biome: BiomeId, pieceNames: string[], d: number): CourseDef {
  const pool = BIOMES[biome].pool;
  const pieces = pieceNames.map((n) => {
    const p = pool.find((q) => q.name === n);
    if (!p) throw new Error('unknown piece ' + n);
    return p;
  });
  return buildCourse({ biome, index: 0, label: 'test' }, { pieces, d });
}

export function piecesOf(biome: BiomeId): string[] {
  return BIOMES[biome].pool.map((p) => p.name);
}

export function buildCourse(spec: CourseSpec, override?: { pieces: Piece[]; d: number }): CourseDef {
  const biome = BIOMES[spec.biome];
  let pieces: Piece[];
  let d: number;
  let twist = NO_TWIST;
  let name = courseName(spec);
  const rng = new Rng(hashString(courseId(spec)));
  if (override) {
    pieces = override.pieces;
    d = override.d;
  } else if (spec.index >= 0) {
    const c = biome.courses[spec.index];
    pieces = c.pieces;
    d = c.d;
  } else {
    const weekly = spec.index === -2;
    const n = weekly ? 7 : 4;
    pieces = rng.shuffle([...biome.pool]).slice(0, n);
    // Pieces that change height (bed, shelf) keep a sensible order.
    pieces.sort((a, b) => (a === bShelf ? 1 : 0) - (b === bShelf ? 1 : 0) || (b === bBed ? 1 : 0) - (a === bBed ? 1 : 0));
    d = weekly ? 2 : 1;
    twist = rng.pick(TWISTS);
    name = `${name}: ${twist.label}`;
  }

  const b = new Builder(biome.floorY, biome.baseMat);
  const checkpoints: Checkpoint[] = [];
  let par = 0;
  const all = [biome.start, ...pieces, biome.goal];
  const sections: CourseDef['sections'] = [];
  all.forEach((piece, i) => {
    if (i > 0) checkpoints.push({ x: b.ox + 1.3, y: b.oy });
    else checkpoints.push({ x: b.ox + 3.2, y: b.oy });
    const out = piece(b, d, rng);
    sections.push({ name: piece.name, x0: b.ox, x1: b.ox + out.w });
    par += out.par;
    b.ox += out.w;
    b.oy += out.exitY ?? 0;
  });
  const width = b.ox;

  // Global floor: the abyss below counters and furniture is a soft landing that resets the crew.
  if (biome.id !== 'playground') {
    b.solids.push({ x: width / 2, y: biome.floorY - 0.5, w: width + 40, h: 1, mat: 'floor' });
    b.zones.push({ kind: 'kill', x: width / 2, y: biome.floorY + 0.4, w: width + 40, h: 0.8, tag: 'floor' });
  } else {
    b.solids.push({ x: width / 2, y: biome.floorY - 0.5, w: width + 40, h: 1, mat: 'mud' });
  }
  // Walls at both ends so nobody wanders off the map.
  b.solids.push({ x: -1, y: 10, w: 2, h: 40, mat: 'wall', tag: 'invisible' });
  b.solids.push({ x: width + 1, y: 10, w: 2, h: 40, mat: 'wall', tag: 'invisible' });

  const cargo = twist.cargo ?? biome.cargo;
  return {
    id: courseId(spec),
    name,
    biome: biome.id,
    cargo,
    scene: biome.scene,
    difficulty: d,
    parTime: Math.round(par * (1 + 0.2 * d)),
    solids: b.solids,
    zones: b.zones,
    movers: b.movers,
    props: b.props,
    collectibles: b.coins,
    checkpoints,
    cargoStart: b.cargoStart,
    goal: b.goal,
    hints: b.hints.sort((a, c) => a.x - c.x),
    decor: b.decor,
    killY: biome.floorY - 3,
    sections,
    bounds: { minX: 0, maxX: width, minY: biome.floorY - 1, maxY: b.maxTop + 8 },
    twist,
  };
}

export function allCampaignSpecs(): CourseSpec[] {
  return BIOME_ORDER.flatMap((biome) => BIOMES[biome].courses.map((_, index) => ({ biome, index })));
}
