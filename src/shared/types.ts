// ---------- Course definition (static, rebuilt identically on every machine from a CourseSpec) ----------

export type BiomeId = 'kitchen' | 'bedroom' | 'playground';
export type CargoKind = 'cake' | 'fishtank' | 'vase' | 'plates';

export interface Solid {
  x: number; // centre
  y: number; // centre
  w: number;
  h: number;
  a?: number; // rotation (radians)
  round?: boolean; // circle of diameter w
  mat: string;
  friction?: number;
  bounce?: number;
  /** Purely decorative detail the renderer may use (e.g. "burner" rings). */
  tag?: string;
}

export type ZoneKind = 'heat' | 'water' | 'wind' | 'kill' | 'sand' | 'slippery' | 'launch';

export interface Zone {
  kind: ZoneKind;
  x: number;
  y: number;
  w: number;
  h: number;
  fx?: number;
  fy?: number;
  /** Periodic hazards: active while ((t + phase) % period) < period * duty. */
  period?: number;
  duty?: number;
  phase?: number;
  tag?: string;
  /** Springboards: where the flight should come down (absolute x, surface y). */
  land?: { x: number; y: number };
}

export type MoverPath =
  | { type: 'line'; ax: number; ay: number; bx: number; by: number; period: number; phase?: number; profile?: 'pingpong' | 'swipe' | 'sine' | 'dwell' }
  | { type: 'pendulum'; px: number; py: number; len: number; amp: number; period: number; phase?: number }
  | { type: 'spin'; x: number; y: number; speed: number }
  | { type: 'breathe'; x: number; y: number; amp: number; period: number };

export interface Mover {
  kind: 'paw' | 'car' | 'swing' | 'blade' | 'dog' | 'platform' | 'belt' | 'lift';
  w: number;
  h: number;
  path: MoverPath;
  mat: string;
  /** Knocks players/cargo on contact (hazard) rather than just being a platform. */
  knock?: { x: number; y: number; damage: number };
  /** Bots don't need to time this one (e.g. a car driving under a bridge). */
  botIgnore?: boolean;
}

export interface Prop {
  kind: 'block' | 'ball' | 'seesaw' | 'pillow';
  x: number;
  y: number;
  w: number;
  h: number;
  mass: number;
  mat: string;
  /** Periodic kick, e.g. a football match. */
  kick?: { period: number; x: number; y: number; phase?: number };
}

export interface Checkpoint {
  x: number;
  y: number; // surface height at the checkpoint
  wp?: number; // index into the course path where this checkpoint's piece starts
}

export interface Waypoint {
  x: number;
  y: number;
  /** pad: wait on the springboard until it fires · lift: board the lift when it's down */
  kind?: 'pad' | 'lift';
  mover?: number;
}

export interface Decor {
  kind: string;
  x: number;
  y: number;
  z: number; // depth: negative = further back
  s: number; // scale
  r?: number; // rotation around y
  c?: number; // colour hint
  text?: string;
}

export interface BotHint {
  x: number;
  y?: number; // surface height, for stacked floors (towers)
  a: 'jump' | 'gap' | 'wait'; // jump: step up (carriers hop together) · gap: each body hops at the edge
}

export interface CourseDef {
  id: string;
  name: string;
  biome: BiomeId;
  cargo: CargoKind;
  scene: 'party' | 'aquarium' | 'grandma' | 'picnic';
  difficulty: number;
  parTime: number;
  solids: Solid[];
  zones: Zone[];
  movers: Mover[];
  props: Prop[];
  collectibles: { x: number; y: number }[];
  checkpoints: Checkpoint[]; // [0] is the start
  cargoStart: { x: number; y: number };
  goal: { x: number; y: number; w: number; h: number };
  hints: BotHint[];
  decor: Decor[];
  killY: number;
  /** The route the cargo takes (bots follow it; towers switch back and forth). */
  path: Waypoint[];
  /** Tower courses climb instead of crossing. */
  vertical?: boolean;
  sections: { name: string; x0: number; x1: number }[];
  bounds: { minX: number; maxX: number; minY: number; maxY: number };
  twist: Twist;
}

export interface Twist {
  id: string;
  label: string;
  gravity: number; // multiplier
  cargoMass: number; // multiplier
  ropeLen: number; // multiplier
  cargo?: CargoKind;
  fragile?: number; // damage multiplier
}

export interface CourseSpec {
  biome: BiomeId;
  index: number; // 0..2 for campaign courses, -1 for daily, -2 for weekly
  seed?: number;
  label?: string;
}

// ---------- Input ----------

export interface PlayerInput {
  mx: number; // -1..1
  up: boolean;
  down: boolean;
  grab: boolean;
  jumpN: number; // press counters (robust to dropped packets / tick timing)
  diveN: number;
  /** Bots only: when grabbing, only take hold of solid things (not the rope). */
  ledge?: boolean;
}

export const emptyInput = (): PlayerInput => ({ mx: 0, up: false, down: false, grab: false, jumpN: 0, diveN: 0 });

// ---------- Crew / cosmetics ----------

export interface Look {
  body: number; // colour index
  shape: number; // body shape index
  hat: string;
  rope: string;
}

export interface CrewMember {
  id: string;
  name: string;
  look: Look;
  bot: boolean;
}

export const PINGS = ['go', 'wait', 'grab', 'jump', 'help'] as const;
export type PingKind = (typeof PINGS)[number];
export const PING_TEXT: Record<PingKind, string> = {
  go: 'Go here!',
  wait: 'Wait!',
  grab: 'Grab it!',
  jump: 'Jump now!',
  help: 'Help!',
};

export const EMOTES = ['highfive', 'blame', 'cheer', 'facepalm'] as const;
export type EmoteKind = (typeof EMOTES)[number];

export const QUICK_CHAT = ['Nice!', 'Sorry!', 'Oops!', "Let's go!", 'Thanks!', 'Careful!'] as const;

// ---------- Events & snapshots ----------

export type GameEvent =
  | { e: 'jump'; p: number }
  | { e: 'land'; p: number; v: number }
  | { e: 'grab'; p: number; what: 'cargo' | 'rope' | 'ledge' | 'prop'; x: number; y: number }
  | { e: 'panic'; p: number }
  | { e: 'release'; p: number }
  | { e: 'slip'; p: number }
  | { e: 'dive'; p: number }
  | { e: 'ouch'; p: number; kind: 'heat' | 'knock' | 'water' }
  | { e: 'damage'; amount: number; x: number; y: number }
  | { e: 'layer'; x: number; y: number } // cake layer / plate lost, fish splash...
  | { e: 'checkpoint'; i: number; x: number; y: number }
  | { e: 'drop'; x: number; y: number }
  | { e: 'reset'; reason: 'fell' | 'drop' | 'stuck' }
  | { e: 'collect'; i: number; x: number; y: number; p: number }
  | { e: 'delivered' }
  | { e: 'kick'; x: number; y: number }
  | { e: 'ping'; p: number; kind: PingKind; x: number; y: number }
  | { e: 'emote'; p: number; kind: EmoteKind; target?: number }
  | { e: 'chat'; p: number; i: number }
  | { e: 'fell'; p: number }
  | { e: 'boing'; x: number; y: number }
  | { e: 'tumble'; p: number; kind: 'land' | 'yank' };

export interface PlayerSnap {
  x: number;
  y: number;
  vx: number;
  vy: number;
  f: number; // facing -1 / 1
  g: 0 | 1; // grounded
  hx?: number; // hand target when gripping
  hy?: number;
  st: number; // stamina 0..1
  s: number; // state: 0 normal, 1 diving, 2 flopped, 3 hanging
  pu: 0 | 1; // panic grab used
  c?: 0 | 1; // holding the cargo
  a?: number; // body tumble angle
}

export interface Snapshot {
  t: number; // sim time
  time: number; // course clock
  status: 'playing' | 'delivered';
  cp: number;
  players: PlayerSnap[];
  rope: number[][]; // per span: flattened x,y of segment centres
  cargo: { parts: number[]; damage: number; slosh: number; held: number };
  movers: number[]; // x,y,a triples
  props: number[]; // x,y,a triples
  zonesOn: number; // bitmask of periodic zones currently active (first 31)
  pl?: number[]; // springboard charge 0..1, one per launch zone (in zone order)
  collected: number[];
  events: GameEvent[];
}

export interface RunResult {
  courseId: string;
  courseName: string;
  stars: number;
  damage: number;
  time: number;
  par: number;
  collectibles: number;
  totalCollectibles: number;
  coins: number;
  crew: string[];
}
