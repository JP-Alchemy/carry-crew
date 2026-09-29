import { DT } from '../shared/constants';
import { buildCourse } from '../shared/courses';
import type { ServerMsg } from '../shared/protocol';
import { Sim } from '../shared/sim';
import type { CourseDef, CourseSpec, CrewMember, EmoteKind, GameEvent, PingKind, PlayerInput, RunResult, Snapshot } from '../shared/types';
import type { Net } from './net';

export interface Session {
  readonly course: CourseDef;
  readonly spec: CourseSpec;
  crew: CrewMember[];
  readonly localSlots: number[];
  readonly online: boolean;
  result: RunResult | null;
  onCrew?: (crew: CrewMember[]) => void;
  onResult?: (r: RunResult) => void;
  frame(dt: number, inputs: PlayerInput[]): Snapshot | null;
  ping(local: number, kind: PingKind, x: number, y: number): void;
  emote(local: number, kind: EmoteKind): void;
  chat(local: number, i: number): void;
  dispose(): void;
}

export function computeResult(course: CourseDef, sim: { starsFor(): number; damage: number; time: number; collected: Set<number> }, crew: CrewMember[]): RunResult {
  const stars = sim.starsFor();
  const collectibles = sim.collected.size;
  return {
    courseId: course.id,
    courseName: course.name,
    stars,
    damage: Math.round(sim.damage),
    time: Math.round(sim.time * 10) / 10,
    par: course.parTime,
    collectibles,
    totalCollectibles: course.collectibles.length,
    coins: stars * 15 + collectibles * 5,
    crew: crew.map((c) => c.name),
  };
}

/** Runs the simulation in the browser: solo with bots, couch co-op, and the title-screen demo. */
export class LocalSession implements Session {
  readonly course: CourseDef;
  readonly sim: Sim;
  readonly online = false;
  result: RunResult | null = null;
  onCrew?: (crew: CrewMember[]) => void;
  onResult?: (r: RunResult) => void;
  private acc = 0;
  private doneT = 0;
  /** Loop forever (title screen). */
  demo = false;

  constructor(
    readonly spec: CourseSpec,
    public crew: CrewMember[],
    readonly localSlots: number[],
  ) {
    this.course = buildCourse(spec);
    this.sim = new Sim(this.course, { crew: crew.map((c) => ({ bot: c.bot })) });
  }

  frame(dt: number, inputs: PlayerInput[]): Snapshot {
    this.localSlots.forEach((slot, k) => inputs[k] && this.sim.setInput(slot, inputs[k]));
    this.acc = Math.min(this.acc + dt, Math.max(DT * 4, dt));
    while (this.acc >= DT) {
      this.sim.step();
      this.acc -= DT;
    }
    if (this.sim.status === 'delivered' && !this.result) {
      this.doneT += dt;
      if (this.doneT > 2.4) {
        this.result = computeResult(this.course, this.sim, this.crew);
        this.onResult?.(this.result);
      }
    }
    return this.sim.snapshot();
  }

  ping(local: number, kind: PingKind, x: number, y: number) {
    this.sim.ping(this.localSlots[local] ?? 0, kind, x, y);
  }
  emote(local: number, kind: EmoteKind) {
    this.sim.emote(this.localSlots[local] ?? 0, kind);
  }
  chat(local: number, i: number) {
    this.sim.chat(this.localSlots[local] ?? 0, i);
  }
  dispose() {
    this.sim.free();
  }
}

// ------------------------------------------------------------------ online

const INTERP_DELAY = 0.1;

function lerpArr(a: number[], b: number[], u: number): number[] {
  if (a.length !== b.length) return b;
  const out = new Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = Math.abs(b[i] - a[i]) > 3 ? b[i] : a[i] + (b[i] - a[i]) * u;
  return out;
}

function lerpAngles(a: number[], b: number[], u: number): number[] {
  if (a.length !== b.length) return b;
  const out = new Array(b.length);
  for (let i = 0; i < b.length; i++) {
    if (i % 3 === 2) {
      let d = b[i] - a[i];
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      out[i] = a[i] + d * u;
    } else out[i] = Math.abs(b[i] - a[i]) > 3 ? b[i] : a[i] + (b[i] - a[i]) * u;
  }
  return out;
}

/**
 * Server-authoritative play. Shared objects (rope, cargo, other players) are interpolated 100 ms in
 * the past for smoothness; your own character is drawn from the newest state and extrapolated, so it
 * reacts without waiting for the interpolation delay.
 */
export class OnlineSession implements Session {
  readonly course: CourseDef;
  readonly online = true;
  result: RunResult | null = null;
  onCrew?: (crew: CrewMember[]) => void;
  onResult?: (r: RunResult) => void;
  private buf: { s: Snapshot; at: number }[] = [];
  private pendingEvents: GameEvent[] = [];
  private offset: number | null = null;
  private clock = 0;
  private sendT = 0;
  private lastSent = '';
  private off: () => void;

  constructor(
    private net: Net,
    readonly spec: CourseSpec,
    public crew: CrewMember[],
    readonly localSlots: number[],
  ) {
    this.course = buildCourse(spec);
    this.off = net.on((m) => this.onMsg(m));
  }

  private onMsg(m: ServerMsg) {
    if (m.t === 'snap') {
      const s = m.s;
      this.pendingEvents.push(...s.events);
      const est = s.t - this.clock;
      this.offset = this.offset === null ? est : this.offset + (est - this.offset) * 0.05;
      if (est < this.offset) this.offset = est; // snap forward on late packets
      this.buf.push({ s, at: this.clock });
      if (this.buf.length > 40) this.buf.shift();
    } else if (m.t === 'crew') {
      this.crew = m.crew;
      this.onCrew?.(m.crew);
    } else if (m.t === 'result') {
      this.result = m.result;
      this.onResult?.(m.result);
    }
  }

  frame(dt: number, inputs: PlayerInput[]): Snapshot | null {
    this.clock += dt;
    this.sendT += dt;
    const inp = inputs[0];
    if (inp) {
      const key = JSON.stringify(inp);
      if (key !== this.lastSent || this.sendT > 0.25) {
        if (this.sendT >= 1 / 30 || key !== this.lastSent) {
          this.net.send({ t: 'input', input: inp });
          this.lastSent = key;
          this.sendT = 0;
        }
      }
    }
    if (!this.buf.length || this.offset === null) return null;
    const renderT = this.clock + this.offset - INTERP_DELAY;
    let a = this.buf[0];
    let b = this.buf[this.buf.length - 1];
    for (let i = 0; i + 1 < this.buf.length; i++) {
      if (this.buf[i].s.t <= renderT && this.buf[i + 1].s.t >= renderT) {
        a = this.buf[i];
        b = this.buf[i + 1];
        break;
      }
    }
    const span = b.s.t - a.s.t;
    const u = span > 0 ? Math.max(0, Math.min(1, (renderT - a.s.t) / span)) : 1;
    const latest = this.buf[this.buf.length - 1].s;
    const players = b.s.players.map((pb, i) => {
      const pa = a.s.players[i] ?? pb;
      if (this.localSlots.includes(i)) {
        // Own character: newest state, nudged forward by its velocity.
        const pl = latest.players[i] ?? pb;
        const ahead = Math.min(0.1, Math.max(0, this.clock + this.offset! - latest.t));
        return { ...pl, x: pl.x + pl.vx * ahead, y: pl.y + pl.vy * ahead };
      }
      const far = Math.abs(pb.x - pa.x) > 3 || Math.abs(pb.y - pa.y) > 3;
      return far ? pb : { ...pb, x: pa.x + (pb.x - pa.x) * u, y: pa.y + (pb.y - pa.y) * u };
    });
    const events = this.pendingEvents;
    this.pendingEvents = [];
    return {
      ...b.s,
      players,
      rope: b.s.rope.map((r, k) => lerpArr(a.s.rope[k] ?? r, r, u)),
      cargo: { ...b.s.cargo, parts: lerpAngles(a.s.cargo.parts, b.s.cargo.parts, u) },
      movers: lerpAngles(a.s.movers, b.s.movers, u),
      props: lerpAngles(a.s.props, b.s.props, u),
      status: latest.status,
      time: latest.time,
      cp: latest.cp,
      events,
    };
  }

  ping(_local: number, kind: PingKind, x: number, y: number) {
    this.net.send({ t: 'ping', kind, x, y });
  }
  emote(_local: number, kind: EmoteKind) {
    this.net.send({ t: 'emote', kind });
  }
  chat(_local: number, i: number) {
    this.net.send({ t: 'chat', i });
  }
  dispose() {
    this.off();
  }
}
