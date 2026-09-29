import RAPIER from '@dimforge/rapier2d-compat';
import * as C from './constants';
import { botInput, newBotBrain, planCrew, type BotBrain } from './bot';
import type {
  CourseDef,
  EmoteKind,
  GameEvent,
  Mover,
  PingKind,
  PlayerInput,
  PlayerSnap,
  Prop,
  Snapshot,
  Zone,
} from './types';
import { emptyInput } from './types';

let ready: Promise<void> | null = null;
/** Load the physics engine (WebAssembly). Safe to call many times. */
export function initPhysics(): Promise<void> {
  if (!ready) ready = RAPIER.init();
  return ready;
}

type Kind = 'terrain' | 'player' | 'rope' | 'cargo' | 'prop' | 'mover';
interface ColliderInfo {
  kind: Kind;
  i: number; // player index / span index / cargo part / prop / mover index
  j?: number; // segment index inside a span
  solid?: number;
}

export interface Grab {
  joint: RAPIER.ImpulseJoint | null; // null for cargo: it's carried by the carry controller
  side: number; // cargo only: which side of the holder the cargo is on
  kind: 'cargo' | 'rope' | 'ledge' | 'prop';
  body: RAPIER.RigidBody;
  span?: number;
  seg?: number;
  part?: number;
  local: { x: number; y: number }; // anchor in the target body's frame
  handOff: { x: number; y: number }; // anchor in the player's frame
}

export interface PlayerState {
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
  input: PlayerInput;
  lastJumpN: number;
  lastDiveN: number;
  bot: boolean;
  brain: BotBrain;
  facing: number;
  grounded: boolean;
  coyote: number;
  jumpBuffer: number;
  grab: Grab | null;
  regrabCd: number;
  climbCd: number;
  stamina: number;
  diveT: number;
  diveCd: number;
  flopT: number;
  panicUsed: boolean;
  killT: number;
  hurtCd: number;
  speedMul: number;
  airVy: number;
  inWater: boolean;
  onCargo: boolean;
  lastUp: boolean;
  restT: number;
}

interface Span {
  a: number;
  b: number;
  segs: RAPIER.RigidBody[];
  spacing: number;
  link: RAPIER.ImpulseJoint;
}

interface CargoPart {
  body: RAPIER.RigidBody;
  w: number;
  h: number;
  alive: boolean;
  prevV: { x: number; y: number };
  restY: number; // offset from the tray for stacked parts
}

interface MoverState {
  def: Mover;
  body: RAPIER.RigidBody;
  x: number;
  y: number;
  a: number;
  vx: number;
  vy: number;
  hitCd: number[];
}

interface PropState {
  def: Prop;
  body: RAPIER.RigidBody;
  lastPhase: number;
}

export interface SimOptions {
  crew: { bot: boolean }[];
}

const FAR = 1e5;
/** How far above a holder's centre the cargo's centre is carried. */
const CARRY_LIFT = 0.45;
const DEBUG_DAMAGE = typeof process !== 'undefined' && !!process.env?.DEBUG_DAMAGE;

export class Sim {
  readonly course: CourseDef;
  readonly world: RAPIER.World;
  readonly players: PlayerState[] = [];
  readonly spans: Span[] = [];
  readonly cargo: CargoPart[] = [];
  readonly movers: MoverState[] = [];
  readonly props: PropState[] = [];
  readonly collected = new Set<number>();
  readonly info = new Map<number, ColliderInfo>();
  t = 0;
  time = 0;
  status: 'playing' | 'delivered' = 'playing';
  cp = 0;
  damage = 0;
  slosh = 0;
  sloshV = 0;
  layersLost = 0;
  deliverT = 0;
  lastFell = -1;
  firstCheckpointAt = -1;
  private events: GameEvent[] = [];
  private eventQueue = new RAPIER.EventQueue(true);
  private terrain: RAPIER.RigidBody;
  private ropeLen: number;
  private cargoMass = 1;
  private fragile: number;
  private resetCd = 0;
  private dmgAccum = 0;

  constructor(course: CourseDef, opts: SimOptions) {
    this.course = course;
    const g = C.GRAVITY * course.twist.gravity;
    this.world = new RAPIER.World({ x: 0, y: g });
    this.world.timestep = C.DT;
    this.world.integrationParameters.numSolverIterations = 8;
    this.ropeLen = C.ROPE_LEN * course.twist.ropeLen;
    this.fragile = course.twist.fragile ?? 1;

    this.terrain = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    course.solids.forEach((s, i) => {
      const desc = (s.round ? RAPIER.ColliderDesc.ball(s.w / 2) : RAPIER.ColliderDesc.cuboid(s.w / 2, s.h / 2))
        .setTranslation(s.x, s.y)
        .setRotation(s.a ?? 0)
        .setFriction(s.friction ?? 0.8)
        .setRestitution(s.bounce ?? 0)
        .setCollisionGroups(C.groups(C.G_TERRAIN, C.G_PLAYER | C.G_ROPE | C.G_CARGO | C.G_PROP));
      const col = this.world.createCollider(desc, this.terrain);
      this.info.set(col.handle, { kind: 'terrain', i: -1, solid: i });
    });

    course.movers.forEach((def, i) => {
      const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased());
      const col = this.world.createCollider(
        RAPIER.ColliderDesc.cuboid(def.w / 2, def.h / 2)
          .setFriction(0.9)
          .setCollisionGroups(C.groups(C.G_PROP, 0xffff)),
        body,
      );
      this.info.set(col.handle, { kind: 'mover', i });
      const m: MoverState = { def, body, x: 0, y: 0, a: 0, vx: 0, vy: 0, hitCd: [0, 0, 0, 0, 0, 0, 0, 0] };
      const p = this.moverPose(def, 0);
      body.setTranslation({ x: p.x, y: p.y }, true);
      body.setRotation(p.a, true);
      Object.assign(m, p);
      this.movers.push(m);
    });

    course.props.forEach((def, i) => {
      const body = this.world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic()
          .setTranslation(def.x, def.y)
          .setLinearDamping(def.kind === 'ball' ? 0.1 : 0.3)
          .setAngularDamping(def.kind === 'seesaw' ? 2 : 0.5),
      );
      const shape = def.kind === 'ball' ? RAPIER.ColliderDesc.ball(def.w / 2) : RAPIER.ColliderDesc.cuboid(def.w / 2, def.h / 2);
      const area = def.kind === 'ball' ? Math.PI * (def.w / 2) ** 2 : def.w * def.h;
      const col = this.world.createCollider(
        shape
          .setDensity(def.mass / area)
          .setFriction(def.kind === 'pillow' ? 1 : 0.7)
          .setRestitution(def.kind === 'ball' ? 0.6 : def.kind === 'pillow' ? 0.5 : 0.05)
          .setCollisionGroups(C.groups(C.G_PROP, 0xffff)),
        body,
      );
      this.info.set(col.handle, { kind: 'prop', i });
      if (def.kind === 'seesaw') {
        const j = this.world.createImpulseJoint(RAPIER.JointData.revolute({ x: def.x, y: def.y }, { x: 0, y: 0 }), this.terrain, body, true);
        (j as RAPIER.RevoluteImpulseJoint).setLimits(-0.2, 0.2);
      }
      this.props.push({ def, body, lastPhase: 0 });
    });

    // Crew
    opts.crew.forEach((c, i) => {
      const body = this.world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic().lockRotations().setLinearDamping(0.05).setCcdEnabled(true).setCanSleep(false),
      );
      const collider = this.world.createCollider(
        RAPIER.ColliderDesc.ball(C.PLAYER_R)
          .setDensity(C.PLAYER_DENSITY)
          .setFriction(0.4)
          .setCollisionGroups(C.PLAYER_GROUPS),
        body,
      );
      this.info.set(collider.handle, { kind: 'player', i });
      this.players.push({
        body,
        collider,
        input: emptyInput(),
        lastJumpN: 0,
        lastDiveN: 0,
        bot: c.bot,
        brain: newBotBrain(i),
        facing: 1,
        grounded: false,
        coyote: 0,
        jumpBuffer: 0,
        grab: null,
        regrabCd: 0,
        climbCd: 0,
        stamina: C.STAMINA_MAX,
        diveT: 0,
        diveCd: 0,
        flopT: 0,
        panicUsed: false,
        killT: 0,
        hurtCd: 0,
        speedMul: 1,
        airVy: 0,
        inWater: false,
        onCargo: false,
        lastUp: false,
        restT: 0,
      });
    });

    this.buildCargo();
    this.buildRope();
    this.placeAtCheckpoint(0);
  }

  // ------------------------------------------------------------------ setup

  private buildCargo() {
    const kind = this.course.cargo;
    const mm = this.course.twist.cargoMass;
    const groups = C.groups(C.G_CARGO, C.G_TERRAIN | C.G_PROP | C.G_CARGO);
    const add = (w: number, h: number, mass: number, restY: number, com?: { x: number; y: number }) => {
      const body = this.world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic().setAngularDamping(kind === 'plates' ? 0.8 : 1.6).setLinearDamping(0.1).setCcdEnabled(true).setCanSleep(false),
      );
      let desc = RAPIER.ColliderDesc.cuboid(w / 2, h / 2)
        .setFriction(kind === 'plates' ? 1.1 : 0.9)
        .setCollisionGroups(groups)
        .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS)
        .setContactForceEventThreshold(mass * 120);
      if (com) desc = desc.setMassProperties(mass, com, (mass * (w * w + h * h)) / 12);
      else desc = desc.setDensity(mass / (w * h));
      const col = this.world.createCollider(desc, body);
      this.info.set(col.handle, { kind: 'cargo', i: this.cargo.length });
      this.cargo.push({ body, w, h, alive: true, prevV: { x: 0, y: 0 }, restY });
    };
    if (kind === 'cake') add(1.35, 0.85, 1.3 * mm, 0);
    else if (kind === 'fishtank') add(1.3, 0.95, 1.5 * mm, 0);
    else if (kind === 'vase') add(0.7, 1.3, 1.1 * mm, 0, { x: 0, y: 0.22 });
    else {
      add(1.5, 0.14, 0.6 * mm, 0);
      for (let i = 0; i < 5; i++) add(1.2, 0.1, 0.13 * mm, 0.12 + i * 0.105);
    }
    this.cargoMass = this.cargo.reduce((s, p) => s + p.body.mass(), 0);
  }

  private buildRope() {
    const n = Math.max(3, Math.round(this.ropeLen / C.ROPE_SEG_SPACING));
    const sp = this.ropeLen / n;
    for (let s = 0; s + 1 < this.players.length; s++) {
      const A = this.players[s].body;
      const B = this.players[s + 1].body;
      const segs: RAPIER.RigidBody[] = [];
      for (let k = 0; k < n; k++) {
        const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setLinearDamping(0.4).setAngularDamping(0.6).setCanSleep(false));
        const col = this.world.createCollider(
          RAPIER.ColliderDesc.capsule(Math.max(0.01, sp / 2 - C.ROPE_SEG_R), C.ROPE_SEG_R)
            .setRotation(Math.PI / 2)
            .setDensity(2.2)
            .setFriction(0.9)
            .setCollisionGroups(C.groups(C.G_ROPE, C.G_TERRAIN | C.G_PROP)),
          body,
        );
        this.info.set(col.handle, { kind: 'rope', i: s, j: k });
        segs.push(body);
      }
      const rev = (a: RAPIER.RigidBody, ax: number, b: RAPIER.RigidBody, bx: number) => {
        const j = this.world.createImpulseJoint(RAPIER.JointData.revolute({ x: ax, y: 0 }, { x: bx, y: 0 }), a, b, true);
        j.setContactsEnabled(false);
      };
      rev(A, 0, segs[0], -sp / 2);
      for (let k = 0; k + 1 < n; k++) rev(segs[k], sp / 2, segs[k + 1], -sp / 2);
      rev(segs[n - 1], sp / 2, B, 0);
      const link = this.world.createImpulseJoint(RAPIER.JointData.rope(this.ropeLen * 1.02, { x: 0, y: 0 }, { x: 0, y: 0 }), A, B, true);
      link.setContactsEnabled(true);
      this.spans.push({ a: s, b: s + 1, segs, spacing: sp, link });
    }
  }

  /** Put crew + cargo at a checkpoint (used at start and after a fall / drop). */
  private placeAtCheckpoint(i: number) {
    const cp = this.course.checkpoints[i];
    const n = this.players.length;
    for (const p of this.players) this.release(p, false);
    const x0 = i === 0 ? cp.x : cp.x - 0.4;
    this.players.forEach((p, k) => {
      const x = x0 + (k - (n - 1) / 2) * 1.0 - (i === 0 ? 0 : 0.8);
      this.teleport(p.body, x, cp.y + C.PLAYER_R + 0.05, 0);
      p.facing = 1;
      p.killT = 0;
      p.flopT = 0;
      p.diveT = 0;
      p.panicUsed = false;
      p.stamina = C.STAMINA_MAX;
      p.brain = newBotBrain(k);
    });
    for (const s of this.spans) this.layRope(s);
    const cx = i === 0 ? this.course.cargoStart.x : cp.x + 1.6;
    const cy = i === 0 ? this.course.cargoStart.y : cp.y;
    this.cargo.forEach((part, k) => {
      if (!part.alive) return;
      const base = this.cargo[0].h / 2 + 0.02;
      const y = k === 0 ? cy + base : cy + this.cargo[0].h + part.restY;
      this.teleport(part.body, cx, y, 0);
      part.prevV = { x: 0, y: 0 };
    });
    this.slosh = 0;
    this.sloshV = 0;
    this.deliverT = 0;
    this.props.forEach((p) => {
      this.teleport(p.body, p.def.x, p.def.y, 0);
    });
  }

  private layRope(s: Span) {
    const a = this.players[s.a].body.translation();
    const b = this.players[s.b].body.translation();
    const n = s.segs.length;
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    // Arch the slack upwards so no segment starts inside the ground.
    const h = Math.sqrt(Math.max(0, (this.ropeLen / 2) ** 2 - (d / 2) ** 2)) * 0.9;
    for (let k = 0; k < n; k++) {
      const u = (k + 0.5) / n;
      const x = a.x + (b.x - a.x) * u;
      const y = a.y + (b.y - a.y) * u + Math.sin(u * Math.PI) * h;
      const u2 = (k + 1) / n;
      const u1 = k / n;
      const ang = Math.atan2(
        (b.y - a.y) * (u2 - u1) + (Math.sin(u2 * Math.PI) - Math.sin(u1 * Math.PI)) * h,
        (b.x - a.x) * (u2 - u1),
      );
      this.teleport(s.segs[k], x, y, ang);
    }
  }

  private teleport(body: RAPIER.RigidBody, x: number, y: number, a: number) {
    body.setTranslation({ x, y }, true);
    body.setRotation(a, true);
    body.setLinvel({ x: 0, y: 0 }, true);
    body.setAngvel(0, true);
  }

  // ------------------------------------------------------------------ public API

  setInput(i: number, input: PlayerInput) {
    const p = this.players[i];
    if (p) p.input = input;
  }

  setBot(i: number, bot: boolean) {
    const p = this.players[i];
    if (!p) return;
    p.bot = bot;
    p.brain = newBotBrain(i);
    if (bot) {
      p.lastJumpN = 0;
      p.lastDiveN = 0;
      p.input = emptyInput();
    }
  }

  ping(p: number, kind: PingKind, x: number, y: number) {
    this.events.push({ e: 'ping', p, kind, x, y });
    this.players.forEach((pl) => {
      if (pl.bot) pl.brain.ping = { kind, x, y, t: this.t };
    });
  }

  emote(p: number, kind: EmoteKind) {
    const pl = this.players[p];
    if (!pl) return;
    const ev: GameEvent = { e: 'emote', p, kind };
    if (kind === 'blame' && this.lastFell >= 0 && this.lastFell !== p) ev.target = this.lastFell;
    if ((kind === 'cheer' || kind === 'highfive') && pl.grounded) {
      pl.body.applyImpulse({ x: 0, y: pl.body.mass() * 4.5 }, true);
    }
    this.events.push(ev);
  }

  chat(p: number, i: number) {
    this.events.push({ e: 'chat', p, i });
  }

  get ropeLength() {
    return this.ropeLen;
  }

  cargoPos() {
    return this.cargo[0].body.translation();
  }

  holders(): number {
    return this.players.reduce((n, p) => n + (p.grab?.kind === 'cargo' ? 1 : 0), 0);
  }

  zoneActive(z: Zone, t = this.t): boolean {
    if (!z.period) return true;
    const ph = (((t + (z.phase ?? 0)) % z.period) + z.period) % z.period;
    return ph < z.period * (z.duty ?? 0.5);
  }

  starsFor(damage = this.damage, time = this.time): number {
    if (this.status !== 'delivered') return 0;
    let s = 1;
    if (damage <= 40) s++;
    if (damage <= 15 && time <= this.course.parTime) s++;
    return s;
  }

  // ------------------------------------------------------------------ step

  step() {
    const dt = C.DT;
    this.t += dt;
    if (this.status === 'playing') this.time += dt;

    this.updateMovers(dt);
    this.updateProps();

    if (this.players.some((p) => p.bot)) planCrew(this);
    for (let i = 0; i < this.players.length; i++) {
      const p = this.players[i];
      if (p.bot) p.input = botInput(this, i, dt);
    }
    for (let i = 0; i < this.players.length; i++) this.controlPlayer(i, dt);
    this.applyZones(dt);
    this.cargoForces(dt);

    for (const part of this.cargo) {
      const v = part.body.linvel();
      part.prevV = { x: v.x, y: v.y };
    }
    this.world.step(this.eventQueue);
    this.cargoImpacts();

    this.afterStep(dt);
  }

  private controlPlayer(i: number, dt: number) {
    const p = this.players[i];
    const b = p.body;
    const m = b.mass();
    const v = b.linvel();
    const inp = p.input;

    p.regrabCd = Math.max(0, p.regrabCd - dt);
    p.climbCd = Math.max(0, p.climbCd - dt);
    p.diveT = Math.max(0, p.diveT - dt);
    p.diveCd = Math.max(0, p.diveCd - dt);
    p.flopT = Math.max(0, p.flopT - dt);
    p.hurtCd = Math.max(0, p.hurtCd - dt);
    p.jumpBuffer = Math.max(0, p.jumpBuffer - dt);
    // Wedged in a corner (resting but no floor under the rays) still counts as footing.
    p.restT = Math.abs(v.y) < 0.08 && !(p.grab && p.grab.kind !== 'cargo') ? p.restT + dt : 0;
    p.coyote = p.grounded || p.restT > 0.2 ? C.COYOTE_TIME : Math.max(0, p.coyote - dt);

    if (inp.jumpN !== p.lastJumpN) {
      p.lastJumpN = inp.jumpN;
      p.jumpBuffer = C.JUMP_BUFFER;
    }
    // "Up" doubles as jump unless you're hanging on (then it climbs / mantles).
    if (inp.up && !p.lastUp && !(p.grab && p.grab.kind !== 'cargo')) p.jumpBuffer = C.JUMP_BUFFER;
    p.lastUp = inp.up;
    let wantDive = false;
    if (inp.diveN !== p.lastDiveN) {
      p.lastDiveN = inp.diveN;
      wantDive = true;
    }

    const control = p.diveT <= 0 && p.flopT <= 0;
    const mx = Math.max(-1, Math.min(1, inp.mx));
    if (control && Math.abs(mx) > 0.2 && !(p.grab && p.grab.kind === 'cargo')) p.facing = Math.sign(mx);
    if (p.grab && p.grab.kind === 'cargo' && control && Math.abs(mx) > 0.2 && p.grounded) {
      // While carrying, face the cargo but still walk.
      const c = p.grab.body.translation();
      p.facing = Math.sign(c.x - b.translation().x) || p.facing;
    }

    // Horizontal movement
    if (control) {
      const carrying = p.grab?.kind === 'cargo';
      const hanging = p.grab && p.grab.kind !== 'cargo' && !p.grounded;
      const speed = (carrying ? C.CARRY_SPEED : C.MOVE_SPEED) * p.speedMul;
      const target = mx * speed;
      const accel = hanging ? 9 : p.grounded ? C.GROUND_ACCEL : C.AIR_ACCEL;
      let dv = target - v.x;
      if (!p.grounded && Math.abs(mx) < 0.2) dv = 0; // keep momentum in the air
      if (!p.grounded && Math.sign(dv) === Math.sign(v.x) && Math.abs(v.x) > speed && Math.abs(mx) > 0.2) dv = 0;
      dv = Math.max(-accel * dt, Math.min(accel * dt, dv));
      b.applyImpulse({ x: dv * m, y: 0 }, true);
    }

    // Jump / mantle / let go
    if (p.jumpBuffer > 0 && control) {
      if (p.grab && p.grab.kind !== 'cargo') {
        const kind = p.grab.kind;
        this.release(p, true);
        p.regrabCd = C.REGRAB_COOLDOWN;
        const up = kind === 'ledge' ? C.JUMP_V * 0.95 : C.JUMP_V * 0.85;
        b.setLinvel({ x: v.x + p.facing * 1.2, y: Math.max(v.y, 0) + up * 0.2 }, true);
        b.applyImpulse({ x: 0, y: up * 0.8 * m }, true);
        p.jumpBuffer = 0;
        this.events.push({ e: 'jump', p: i });
      } else if (p.coyote > 0) {
        b.setLinvel({ x: v.x, y: C.JUMP_V * Math.sqrt(this.course.twist.gravity) }, true);
        if (p.grab?.kind === 'cargo') {
          const share = this.cargoMass / Math.max(1, this.holders());
          this.cargo[0].body.applyImpulse({ x: 0, y: share * C.JUMP_V * 0.3 }, true);
        }
        p.coyote = 0;
        p.jumpBuffer = 0;
        p.grounded = false;
        this.events.push({ e: 'jump', p: i });
      }
    }

    // Dive
    if (wantDive && control && p.diveCd <= 0 && !(p.grab && p.grab.kind !== 'cargo')) {
      if (p.grab) this.release(p, true);
      b.applyImpulse({ x: p.facing * C.DIVE_IMPULSE_X * m, y: C.DIVE_IMPULSE_Y * m }, true);
      p.diveT = C.DIVE_TIME;
      p.diveCd = C.DIVE_COOLDOWN;
      this.events.push({ e: 'dive', p: i });
    }

    // Grab
    const falling = !p.grounded && v.y < -5.5;
    if (inp.grab || p.diveT > 0) {
      if (!p.grab && p.regrabCd <= 0 && p.stamina > 0.2) {
        if (!this.tryGrab(i, C.GRAB_RADIUS, false) && inp.grab && falling && !p.panicUsed) {
          if (this.tryGrab(i, C.PANIC_RADIUS, true)) {
            p.panicUsed = true;
            this.events.push({ e: 'panic', p: i });
          }
        }
      }
    } else if (p.grab) {
      this.release(p, true);
    }

    // Climb the rope / haul up a ledge
    if (p.grab && control && p.climbCd <= 0 && (inp.up || inp.down)) {
      if (p.grab.kind === 'rope' && p.grab.span !== undefined && p.grab.seg !== undefined) {
        const s = this.spans[p.grab.span];
        const k = p.grab.seg;
        const opts = [k - 1, k + 1].filter((q) => q >= 1 && q < s.segs.length - 1);
        let best = -1;
        let bestY = inp.up ? -Infinity : Infinity;
        for (const q of opts) {
          const y = s.segs[q].translation().y;
          if (inp.up ? y > bestY : y < bestY) {
            bestY = y;
            best = q;
          }
        }
        const here = s.segs[k].translation().y;
        if (best >= 0 && (inp.up ? bestY > here - 0.05 : bestY < here + 0.05)) {
          const span = p.grab.span;
          this.release(p, false);
          this.attach(i, 'rope', s.segs[best], { x: 0, y: 0 }, { span, seg: best });
          p.climbCd = 0.12;
        }
      } else if (p.grab.kind === 'ledge' && inp.up) {
        // Mantle: pull yourself up and over.
        this.release(p, true);
        p.regrabCd = C.REGRAB_COOLDOWN;
        b.setLinvel({ x: p.facing * 2.2, y: C.JUMP_V * 0.92 }, true);
        this.events.push({ e: 'jump', p: i });
      }
    }

    // Stamina for hanging
    if (p.grab && !p.grounded) {
      const rate = p.grab.kind === 'cargo' ? 0.35 : 1;
      p.stamina -= dt * rate;
      if (p.stamina <= 0) {
        p.stamina = 0;
        this.release(p, true);
        p.regrabCd = 1.2;
      }
    } else if (p.grounded) {
      p.stamina = Math.min(C.STAMINA_MAX, p.stamina + dt * 2.5);
    }

    // While hanging, slowly reel toward the rope/ledge a little so gripping feels sticky.
    p.speedMul = 1;
  }

  private handPos(p: PlayerState) {
    const t = p.body.translation();
    return { x: t.x + p.facing * (C.PLAYER_R + 0.08), y: t.y + 0.08 };
  }

  private tryGrab(i: number, radius: number, panic: boolean): boolean {
    const p = this.players[i];
    const center = p.body.translation();
    const hand = this.handPos(p);
    const probes = panic ? [center] : [hand, center];
    const probeR = panic ? radius : [radius, C.PLAYER_R + 0.16];
    let best: { col: RAPIER.Collider; info: ColliderInfo; pt: { x: number; y: number }; score: number } | null = null;
    probes.forEach((probe, pi) => {
      const r = Array.isArray(probeR) ? probeR[pi] : probeR;
      this.world.intersectionsWithShape(probe, 0, new RAPIER.Ball(r), (col) => {
        const info = this.info.get(col.handle);
        if (!info || info.kind === 'player') return true;
        if (p.input.ledge && (info.kind === 'rope' || info.kind === 'cargo')) return true;
        if (info.kind === 'cargo' && p.onCargo) return true;
        if (info.kind === 'terrain' && this.course.solids[info.solid!]?.tag === 'invisible') return true;
        if (info.kind === 'rope') {
          const n = this.spans[info.i].segs.length;
          const own = info.i === i || info.i === i - 1;
          // Your own rope is only worth grabbing to climb it: when dangling, or when pushing up.
          if (own && p.grounded && !p.input.up) return true;
          const near = (info.i === i && info.j! < 1) || (info.i === i - 1 && info.j! >= n - 1);
          if (near) return true;
        }
        const proj = col.projectPoint(probe, true);
        const pt = proj ? { x: proj.point.x, y: proj.point.y } : { x: probe.x, y: probe.y };
        const dist = Math.hypot(pt.x - probe.x, pt.y - probe.y);
        const pri = panic ? 0 : info.kind === 'cargo' ? -1 : info.kind === 'prop' || info.kind === 'mover' ? 0.4 : info.kind === 'rope' ? 0.5 : 0.8;
        const score = pri + dist + pi * 0.3;
        if (!best || score < best.score) best = { col, info, pt, score };
        return true;
      });
    });
    if (!best) return false;
    const { col, info, pt } = best as { col: RAPIER.Collider; info: ColliderInfo; pt: { x: number; y: number } };
    const body = col.parent()!;
    if (info.kind === 'rope') {
      return !!this.attach(i, 'rope', body, { x: 0, y: 0 }, { span: info.i, seg: info.j });
    }
    const kind = info.kind === 'cargo' ? 'cargo' : info.kind === 'terrain' ? 'ledge' : 'prop';
    const bt = body.translation();
    const ba = body.rotation();
    const dx = pt.x - bt.x;
    const dy = pt.y - bt.y;
    const c = Math.cos(-ba);
    const s = Math.sin(-ba);
    const local = { x: dx * c - dy * s, y: dx * s + dy * c };
    if (kind === 'cargo') {
      // Cargo isn't pinned: the carry controller lifts it to the holders' hands (see cargoForces).
      const main = this.cargo[0];
      const mt = main.body.translation();
      const side = Math.sign(mt.x - center.x) || p.facing;
      const g: Grab = { joint: null, kind: 'cargo', body: main.body, side, local: { x: -side * (main.w / 2), y: 0 }, handOff: { x: side * C.PLAYER_R, y: CARRY_LIFT }, part: 0 };
      p.grab = g;
      p.facing = side;
      this.events.push({ e: 'grab', p: i, what: 'cargo', x: pt.x, y: pt.y });
      return true;
    }
    if (panic) {
      // Panic grab yanks you to the grip point.
      const d = Math.hypot(pt.x - center.x, pt.y - center.y) || 1;
      const off = C.PLAYER_R + 0.05;
      p.body.setTranslation({ x: pt.x - ((pt.x - center.x) / d) * off, y: pt.y - ((pt.y - center.y) / d) * off }, true);
      p.body.setLinvel({ x: 0, y: 0 }, true);
    }
    return !!this.attach(i, kind, body, local, {}, pt);
  }

  private attach(
    i: number,
    kind: Grab['kind'],
    body: RAPIER.RigidBody,
    local: { x: number; y: number },
    extra: { span?: number; seg?: number; part?: number },
    worldPt?: { x: number; y: number },
  ): Grab | null {
    const p = this.players[i];
    const c = p.body.translation();
    const wp =
      worldPt ??
      (() => {
        const t = body.translation();
        const a = body.rotation();
        return { x: t.x + local.x * Math.cos(a) - local.y * Math.sin(a), y: t.y + local.x * Math.sin(a) + local.y * Math.cos(a) };
      })();
    // Zero-error joint: anchor exactly where the hand touches, so grabbing never yanks.
    const hx = wp.x - c.x;
    const hy = wp.y - c.y;
    if (Math.hypot(hx, hy) > C.PLAYER_R + 0.45) return null;
    const joint = this.world.createImpulseJoint(RAPIER.JointData.revolute({ x: hx, y: hy }, local), p.body, body, true);
    joint.setContactsEnabled(false);
    p.grab = { joint, side: 0, kind, body, local, handOff: { x: hx, y: hy }, ...extra };
    if (Math.abs(hx) > 0.05) p.facing = Math.sign(hx);
    this.events.push({ e: 'grab', p: i, what: kind, x: wp.x, y: wp.y });
    return p.grab;
  }

  release(p: PlayerState, emit: boolean) {
    if (!p.grab) return;
    if (p.grab.joint?.isValid()) this.world.removeImpulseJoint(p.grab.joint, true);
    p.grab = null;
    if (emit) this.events.push({ e: 'release', p: this.players.indexOf(p) });
  }

  moverPose(def: Mover, t: number) {
    const p = def.path;
    const ease = (u: number) => u * u * (3 - 2 * u);
    switch (p.type) {
      case 'line': {
        const ph = (((t / p.period + (p.phase ?? 0)) % 1) + 1) % 1;
        let u: number;
        if (p.profile === 'swipe') {
          if (ph < 0.58) u = 0;
          else if (ph < 0.7) u = ease((ph - 0.58) / 0.12);
          else if (ph < 0.78) u = 1;
          else u = 1 - ease((ph - 0.78) / 0.22);
        } else u = 0.5 - 0.5 * Math.cos(ph * Math.PI * 2);
        return { x: p.ax + (p.bx - p.ax) * u, y: p.ay + (p.by - p.ay) * u, a: 0 };
      }
      case 'pendulum': {
        const th = p.amp * Math.sin((t / p.period + (p.phase ?? 0)) * Math.PI * 2);
        return { x: p.px + p.len * Math.sin(th), y: p.py - p.len * Math.cos(th), a: th };
      }
      case 'spin':
        return { x: p.x, y: p.y, a: p.speed * t };
      case 'breathe':
        return { x: p.x, y: p.y + p.amp * 0.5 * (1 - Math.cos((t / p.period) * Math.PI * 2)), a: 0 };
    }
  }

  private updateMovers(dt: number) {
    for (const m of this.movers) {
      const n = this.moverPose(m.def, this.t);
      m.vx = (n.x - m.x) / dt;
      m.vy = (n.y - m.y) / dt;
      m.x = n.x;
      m.y = n.y;
      m.a = n.a;
      m.body.setNextKinematicTranslation({ x: n.x, y: n.y });
      m.body.setNextKinematicRotation(n.a);
      for (let k = 0; k < m.hitCd.length; k++) m.hitCd[k] = Math.max(0, m.hitCd[k] - dt);
      const knock = m.def.knock;
      if (!knock) continue;
      const speed = Math.hypot(m.vx, m.vy);
      if (speed < 1.5) continue;
      const dir = Math.sign(m.vx) || 1;
      const hw = m.def.w / 2 + 0.12;
      const hh = m.def.h / 2 + 0.12;
      this.players.forEach((p, k) => {
        const t = p.body.translation();
        if (m.hitCd[k] > 0) return;
        if (Math.abs(t.x - m.x) < hw + C.PLAYER_R && Math.abs(t.y - m.y) < hh + C.PLAYER_R) {
          if (p.grab && p.grab.kind !== 'cargo') this.release(p, true);
          p.body.setLinvel({ x: dir * Math.abs(knock.x), y: knock.y }, true);
          p.flopT = 0.7;
          m.hitCd[k] = 0.8;
          this.events.push({ e: 'ouch', p: k, kind: 'knock' });
        }
      });
      const c = this.cargo[0];
      const ct = c.body.translation();
      if (m.hitCd[7] <= 0 && Math.abs(ct.x - m.x) < hw + c.w / 2 && Math.abs(ct.y - m.y) < hh + c.h / 2) {
        c.body.applyImpulse({ x: dir * Math.abs(knock.x) * 0.5 * c.body.mass(), y: knock.y * 0.4 * c.body.mass() }, true);
        this.hurtCargo(knock.damage, ct.x, ct.y);
        m.hitCd[7] = 1;
      }
    }
  }

  private updateProps() {
    for (const pr of this.props) {
      const k = pr.def.kick;
      const t = pr.body.translation();
      if (t.y < this.course.killY) this.teleport(pr.body, pr.def.x, pr.def.y, 0);
      if (!k) continue;
      const ph = (((this.t / k.period + (k.phase ?? 0)) % 1) + 1) % 1;
      if (pr.lastPhase > ph) {
        // New cycle: the ball comes back to the kicker.
        this.teleport(pr.body, pr.def.x, pr.def.y, 0);
      }
      if (pr.lastPhase < 0.3 && ph >= 0.3) {
        pr.body.applyImpulse({ x: k.x * pr.body.mass(), y: k.y * pr.body.mass() }, true);
        this.events.push({ e: 'kick', x: t.x, y: t.y });
      }
      pr.lastPhase = ph;
    }
  }

  private inZone(z: Zone, x: number, y: number, pad = 0) {
    return Math.abs(x - z.x) <= z.w / 2 + pad && Math.abs(y - z.y) <= z.h / 2 + pad;
  }

  private applyZones(dt: number) {
    const zones = this.course.zones;
    for (let i = 0; i < this.players.length; i++) {
      const p = this.players[i];
      const t = p.body.translation();
      const m = p.body.mass();
      let inKill = false;
      let wet = false;
      for (const z of zones) {
        if (!this.inZone(z, t.x, t.y, C.PLAYER_R * 0.6)) continue;
        if (z.kind === 'kill') {
          inKill = true;
          continue;
        }
        if (!this.zoneActive(z)) continue;
        switch (z.kind) {
          case 'heat':
            if (p.hurtCd <= 0) {
              if (p.grab && p.grab.kind !== 'cargo') this.release(p, true);
              p.body.setLinvel({ x: p.body.linvel().x * 0.5 - p.facing * 1.5, y: 8 }, true);
              p.flopT = 0.45;
              p.hurtCd = 0.6;
              this.events.push({ e: 'ouch', p: i, kind: 'heat' });
            }
            break;
          case 'water':
            wet = true;
            p.body.applyImpulse({ x: (z.fx ?? 0) * m * dt, y: (z.fy ?? 0) * m * dt }, true);
            break;
          case 'wind':
            p.body.applyImpulse({ x: (z.fx ?? 0) * m * dt, y: (z.fy ?? 0) * m * dt }, true);
            break;
          case 'sand':
            p.speedMul = 0.45;
            break;
          case 'slippery':
            p.speedMul = 1.3;
            break;
        }
      }
      if (wet && !p.inWater) this.events.push({ e: 'ouch', p: i, kind: 'water' });
      p.inWater = wet;
      // Bobbing on the rope at the edge of a kill zone still counts.
      p.killT = inKill ? p.killT + dt : Math.max(0, p.killT - dt * 0.5);
      if (p.killT > C.KILL_GRACE || t.y < this.course.killY) {
        this.lastFell = i;
        this.events.push({ e: 'fell', p: i });
        this.crewReset('fell');
        return;
      }
    }

    // Cargo
    for (const part of this.cargo) {
      if (!part.alive) continue;
      const t = part.body.translation();
      const m = part.body.mass();
      for (const z of zones) {
        if (!this.inZone(z, t.x, t.y)) continue;
        if (z.kind === 'kill') {
          if (part === this.cargo[0]) {
            this.events.push({ e: 'drop', x: t.x, y: t.y });
            this.crewReset('drop');
            return;
          }
          continue;
        }
        if (!this.zoneActive(z)) continue;
        if (z.kind === 'heat') this.hurtCargo(16 * dt, t.x, t.y);
        else if (z.kind === 'water') {
          part.body.applyImpulse({ x: 0, y: (z.fy ?? 0) * m * dt * 0.6 }, true);
          this.hurtCargo((this.course.cargo === 'fishtank' ? 3 : 9) * dt, t.x, t.y);
        } else if (z.kind === 'wind') part.body.applyImpulse({ x: (z.fx ?? 0) * m * dt * 0.7, y: (z.fy ?? 0) * m * dt * 0.7 }, true);
      }
      if (t.y < this.course.killY && part === this.cargo[0]) {
        this.events.push({ e: 'drop', x: t.x, y: t.y });
        this.crewReset('drop');
        return;
      }
    }

    // Props and rope in the wind
    for (const z of zones) {
      if (z.kind !== 'wind' || !this.zoneActive(z)) continue;
      for (const pr of this.props) {
        const t = pr.body.translation();
        if (pr.def.kind !== 'seesaw' && this.inZone(z, t.x, t.y)) pr.body.applyImpulse({ x: (z.fx ?? 0) * pr.body.mass() * dt * 0.5, y: 0 }, true);
      }
      for (const s of this.spans)
        for (const seg of s.segs) {
          const t = seg.translation();
          if (this.inZone(z, t.x, t.y)) seg.applyImpulse({ x: (z.fx ?? 0) * seg.mass() * dt * 0.8, y: (z.fy ?? 0) * seg.mass() * dt }, true);
        }
    }
  }

  /**
   * The carry controller: the cargo is pulled toward the holders' hands with a capped force, so
   * obstacles still block and bump it. Holders feel the drag, and if it snags too far behind, it
   * slips out of their hands. Two holders (or a solo crew) can lift it; one holder mostly drags it.
   */
  private carry(holders: PlayerState[], dt: number) {
    const main = this.cargo[0];
    const b = main.body;
    const m = b.mass();
    const g = -C.GRAVITY * this.course.twist.gravity;
    const n = holders.length;
    const strong = n >= Math.min(2, this.players.length);
    let tx = 0;
    let ty = 0;
    let hvx = 0;
    let hvy = 0;
    const cx = b.translation().x;
    for (const h of holders) {
      const t = h.body.translation();
      const v = h.body.linvel();
      const g = h.grab!;
      if ((cx - t.x) * g.side < -0.3) {
        g.side = -g.side;
        g.local = { x: -g.local.x, y: g.local.y };
      }
      tx += t.x + g.side * (C.PLAYER_R + main.w / 2 + 0.03);
      ty += t.y + CARRY_LIFT;
      hvx += v.x;
      hvy += v.y;
    }
    tx /= n;
    ty /= n;
    hvx /= n;
    hvy /= n;
    const pos = b.translation();
    const v = b.linvel();
    const w0 = strong ? 11 : 6;
    let fx = m * (w0 * w0 * (tx - pos.x) - 1.6 * w0 * (v.x - hvx));
    let fy = m * (w0 * w0 * (ty - pos.y) - 1.6 * w0 * (v.y - hvy));
    const cap = m * (strong ? 32 : 12);
    const f = Math.hypot(fx, fy);
    if (f > cap) {
      fx *= cap / f;
      fy *= cap / f;
    }
    b.applyImpulse({ x: fx * dt, y: fy * dt }, true);
    for (const part of this.cargo) if (part.alive) part.body.applyImpulse({ x: 0, y: part.body.mass() * g * (strong ? 1 : 0.55) * dt }, true);
    // Holders feel it: the drag of a snagged cargo, and its weight.
    for (const h of holders) {
      const weight = (this.cargoMass * g * (strong ? 0.35 : 0.6)) / n;
      h.body.applyImpulse({ x: (-fx * 0.45 * dt) / n, y: (-Math.max(0, fy) * 0.25 * dt) / n - (h.grounded ? weight * dt : 0) }, true);
    }
    // Keep it level when carried properly; a lone holder lets it tilt.
    const k = strong ? 14 : 3;
    b.applyTorqueImpulse((-b.rotation() * k - b.angvel() * (strong ? 2.2 : 0.6)) * m * dt, true);
    // Snagged too far from someone's hands? It slips.
    for (const h of holders) {
      const t = h.body.translation();
      const a = b.rotation();
      const ax = pos.x + h.grab!.local.x * Math.cos(a) - h.grab!.local.y * Math.sin(a);
      const ay = pos.y + h.grab!.local.x * Math.sin(a) + h.grab!.local.y * Math.cos(a);
      if (Math.hypot(ax - (t.x + h.grab!.side * C.PLAYER_R), ay - (t.y + CARRY_LIFT)) > 1.5) {
        this.release(h, true);
        h.regrabCd = 0.5;
        this.events.push({ e: 'slip', p: this.players.indexOf(h) });
      }
    }
  }

  private cargoForces(dt: number) {
    const main = this.cargo[0];
    const holders = this.players.filter((p) => p.grab && p.grab.kind === 'cargo');
    if (holders.length) this.carry(holders, dt);
    if (this.course.cargo === 'fishtank') {
      const v = main.body.linvel();
      const ax = (v.x - main.prevV.x) / dt;
      const acc = -40 * this.slosh - 3.2 * this.sloshV - ax * 0.09 + main.body.angvel() * 0.3;
      this.sloshV += acc * dt;
      this.slosh += this.sloshV * dt;
      main.body.applyTorqueImpulse(this.slosh * 1.6 * main.body.mass() * dt, true);
      if (Math.abs(this.slosh) > 0.85) {
        const ct = main.body.translation();
        this.hurtCargo(22 * dt * (Math.abs(this.slosh) - 0.6), ct.x, ct.y + 0.4);
        if (Math.random() < 0.08) this.events.push({ e: 'layer', x: ct.x + Math.sign(this.slosh) * 0.6, y: ct.y + 0.5 });
      }
    }
  }

  /** Impacts against the world (not the crew's grip) hurt the cargo. */
  private cargoImpacts() {
    this.eventQueue.drainContactForceEvents((ev) => {
      const a = this.info.get(ev.collider1());
      const b = this.info.get(ev.collider2());
      const cargo = a?.kind === 'cargo' ? a : b?.kind === 'cargo' ? b : undefined;
      const other = cargo === a ? b : a;
      if (!cargo || !other || other.kind === 'player' || other.kind === 'rope') return;
      if (other.kind === 'cargo' && this.course.cargo !== 'plates') return;
      if (this.t < 0.5 || this.resetCd > 0) return;
      const part = this.cargo[cargo.i];
      // Slow bumps (settling, being picked up) never hurt; crashes do.
      if (Math.hypot(part.prevV.x, part.prevV.y) < 1.4) return;
      const accel = ev.maxForceMagnitude() / part.body.mass();
      // Resting / carried contact stays well under the threshold; a 1 m drop onto the counter costs ~7%.
      const amount = Math.min(25, Math.max(0, accel - 300) * (cargo.i === 0 ? 0.06 : 0.02));
      if (amount > 0.05) {
        const t = part.body.translation();
        if (DEBUG_DAMAGE) console.log(`impact a=${accel.toFixed(0)} dmg=${amount.toFixed(1)} vs ${other.kind} t=${this.t.toFixed(2)} holders=${this.holders()}`);
        this.hurtCargo(amount, t.x, t.y);
      }
    });
  }

  hurtCargo(amount: number, x: number, y: number) {
    if (this.status !== 'playing' || amount <= 0) return;
    const a = amount * this.fragile * (this.course.cargo === 'vase' ? 1.3 : 1);
    const before = this.damage;
    this.damage = Math.min(100, this.damage + a);
    this.dmgAccum += this.damage - before;
    if (this.dmgAccum >= 1) {
      this.events.push({ e: 'damage', amount: Math.round(this.dmgAccum), x, y });
      this.dmgAccum = 0;
    }
    if (this.course.cargo === 'cake' || this.course.cargo === 'vase') {
      const lost = Math.floor(this.damage / 34);
      while (this.layersLost < lost) {
        this.layersLost++;
        this.events.push({ e: 'layer', x, y });
      }
    }
  }

  private crewReset(reason: 'fell' | 'drop') {
    if (this.resetCd > 0) return;
    this.resetCd = 0.5;
    if (reason === 'drop') this.hurtCargo(C.DROP_DAMAGE, this.cargoPos().x, this.cargoPos().y);
    this.events.push({ e: 'reset', reason });
    this.placeAtCheckpoint(this.cp);
  }

  private afterStep(dt: number) {
    this.resetCd = Math.max(0, this.resetCd - dt);
    // Ground detection for next step: three short rays under the body.
    const groundFilter = (col: RAPIER.Collider) => {
      const inf = this.info.get(col.handle);
      if (!inf || inf.kind === 'rope') return false;
      if (inf.kind === 'terrain') return this.course.solids[inf.solid!]?.tag !== 'invisible';
      return true;
    };
    for (let i = 0; i < this.players.length; i++) {
      const p = this.players[i];
      const t = p.body.translation();
      const v = p.body.linvel();
      let hit: RAPIER.RayColliderHit | null = null;
      for (const ox of [0, -0.55, 0.55, -0.86, 0.86]) {
        const dy = Math.sqrt(1 - ox * ox) * C.PLAYER_R;
        const h = this.world.castRay(
          new RAPIER.Ray({ x: t.x + ox * C.PLAYER_R, y: t.y }, { x: 0, y: -1 }),
          dy + 0.08,
          true,
          undefined,
          C.groups(C.G_PLAYER, C.G_TERRAIN | C.G_PROP),
          p.collider,
          undefined,
          groundFilter,
        );
        if (h) {
          hit = h;
          break;
        }
      }
      const was = p.grounded;
      p.grounded = !!hit && v.y < 3.5;
      p.onCargo = !!hit && this.info.get(hit.collider.handle)?.kind === 'cargo';
      // You can't lift something you're standing on.
      if (p.onCargo && p.grab?.kind === 'cargo') this.release(p, true);
      if (!p.grounded) p.airVy = Math.min(p.airVy, v.y);
      if (p.grounded && !was) {
        if (p.airVy < -7) this.events.push({ e: 'land', p: i, v: -p.airVy });
        p.airVy = 0;
      }
      if (p.grounded) p.airVy = 0;
      // Anything this far out of the world is a fall.
      if (!Number.isFinite(t.x) || !Number.isFinite(t.y)) {
        this.crewReset('fell');
        return;
      }
    }

    // Plates that leave the tray are lost.
    if (this.course.cargo === 'plates') {
      const tray = this.cargo[0].body.translation();
      for (let k = 1; k < this.cargo.length; k++) {
        const part = this.cargo[k];
        if (!part.alive) continue;
        const t = part.body.translation();
        if (Math.hypot(t.x - tray.x, t.y - tray.y) > 1.8 || t.y < tray.y - 0.5) {
          part.alive = false;
          part.body.setEnabled(false);
          this.hurtCargo(17, t.x, t.y);
          this.events.push({ e: 'layer', x: t.x, y: t.y });
        }
      }
    }

    if (this.status !== 'playing') return;

    // Checkpoints follow the cargo.
    const ct = this.cargoPos();
    const next = this.course.checkpoints[this.cp + 1];
    if (next && ct.x > next.x + 0.6 && ct.y > next.y - 1.5) {
      this.cp++;
      for (const p of this.players) p.panicUsed = false;
      if (this.firstCheckpointAt < 0) this.firstCheckpointAt = this.time;
      this.events.push({ e: 'checkpoint', i: this.cp, x: next.x, y: next.y });
    }

    // Collectibles
    this.course.collectibles.forEach((c, i) => {
      if (this.collected.has(i)) return;
      for (let k = 0; k < this.players.length; k++) {
        const t = this.players[k].body.translation();
        if (Math.hypot(t.x - c.x, t.y - c.y) < 0.75) {
          this.collected.add(i);
          this.events.push({ e: 'collect', i, x: c.x, y: c.y, p: k });
          break;
        }
      }
    });

    // Delivery
    const g = this.course.goal;
    const v = this.cargo[0].body.linvel();
    if (Math.abs(ct.x - g.x) < g.w / 2 && Math.abs(ct.y - g.y) < g.h / 2 && Math.hypot(v.x, v.y) < 1.5) {
      this.deliverT += dt;
      if (this.deliverT > C.DELIVER_HOLD) {
        this.status = 'delivered';
        this.events.push({ e: 'delivered' });
        for (const p of this.players) this.release(p, false);
      }
    } else this.deliverT = 0;
  }

  // ------------------------------------------------------------------ snapshot

  snapshot(): Snapshot {
    const r2 = (n: number) => Math.round(n * 100) / 100 || 0;
    const players: PlayerSnap[] = this.players.map((p) => {
      const t = p.body.translation();
      const v = p.body.linvel();
      const s: PlayerSnap = {
        x: r2(t.x),
        y: r2(t.y),
        vx: r2(v.x),
        vy: r2(v.y),
        f: p.facing,
        g: p.grounded ? 1 : 0,
        st: r2(p.stamina / C.STAMINA_MAX),
        s: p.diveT > 0 ? 1 : p.flopT > 0 ? 2 : p.grab && !p.grounded ? 3 : 0,
        pu: p.panicUsed ? 1 : 0,
        c: p.grab?.kind === 'cargo' ? 1 : 0,
      };
      if (p.grab) {
        const bt = p.grab.body.translation();
        const a = p.grab.body.rotation();
        const c = Math.cos(a);
        const sn = Math.sin(a);
        s.hx = r2(bt.x + p.grab.local.x * c - p.grab.local.y * sn);
        s.hy = r2(bt.y + p.grab.local.x * sn + p.grab.local.y * c);
      }
      return s;
    });
    const rope = this.spans.map((s) => {
      const out: number[] = [];
      for (const seg of s.segs) {
        const t = seg.translation();
        out.push(r2(t.x), r2(t.y));
      }
      return out;
    });
    const parts: number[] = [];
    for (const c of this.cargo) {
      if (!c.alive) {
        parts.push(FAR, FAR, 0);
        continue;
      }
      const t = c.body.translation();
      parts.push(r2(t.x), r2(t.y), r2(c.body.rotation()));
    }
    const movers: number[] = [];
    for (const m of this.movers) movers.push(r2(m.x), r2(m.y), r2(m.a));
    const props: number[] = [];
    for (const p of this.props) {
      const t = p.body.translation();
      props.push(r2(t.x), r2(t.y), r2(p.body.rotation()));
    }
    let zonesOn = 0;
    this.course.zones.forEach((z, i) => {
      if (i < 31 && this.zoneActive(z)) zonesOn |= 1 << i;
    });
    const events = this.events;
    this.events = [];
    return {
      t: r2(this.t),
      time: r2(this.time),
      status: this.status,
      cp: this.cp,
      players,
      rope,
      cargo: { parts, damage: Math.round(this.damage * 10) / 10, slosh: r2(this.slosh), held: this.holders() },
      movers,
      props,
      zonesOn,
      collected: [...this.collected],
      events,
    };
  }

  /** Drain pending events without building a snapshot (server uses snapshot(), local play too). */
  peekEvents(): readonly GameEvent[] {
    return this.events;
  }

  free() {
    this.world.free();
  }
}
