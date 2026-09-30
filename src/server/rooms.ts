import { randomInt } from 'node:crypto';
import { WebSocket, type RawData } from 'ws';
import { DT, MAX_CREW } from '../shared/constants';
import { sanitizeLook } from '../shared/cosmetics';
import { BIOMES, BIOME_ORDER, buildCourse, courseId, dailySpec, weeklySpec } from '../shared/courses';
import { botName, isSafeName } from '../shared/names';
import { PROTOCOL_VERSION, type LobbyState, type ServerMsg } from '../shared/protocol';
import { Sim } from '../shared/sim';
import {
  EMOTES,
  PINGS,
  QUICK_CHAT,
  emptyInput,
  type BiomeId,
  type CourseDef,
  type CourseSpec,
  type CrewMember,
  type EmoteKind,
  type Look,
  type PingKind,
  type PlayerInput,
  type RunResult,
} from '../shared/types';
import type { Store } from './store';
import { Bucket, clamp, finite, isHexId, isObj, newId, safeRandomName } from './util';

export interface GameOptions {
  /** How long a quick crew waits for more humans before bots fill in. */
  quickWaitMs: number;
  /** Safety net: runs longer than this end with 0 stars. */
  maxRunMs: number;
  /** Celebration time between delivery and the result screen. */
  resultDelayMs: number;
  log: boolean;
}

type RoomState = 'lobby' | 'playing' | 'results';

export interface Client {
  ws: WebSocket;
  ip: string;
  id: string;
  name: string;
  look: Look;
  stars: number;
  room: Room | null;
  /** Seat in the running sim, -1 when not playing. */
  slot: number;
  input: PlayerInput;
  /** Re-base the sim's press counters on the next input (client counters persist across runs). */
  syncInput: boolean;
  reports: number;
  msgs: Bucket;
  pings: Bucket;
  social: Bucket;
  ctrl: Bucket;
}

interface Room {
  uid: number;
  mode: 'quick' | 'friends';
  code: string | null;
  bracket: number;
  state: RoomState;
  hostId: string | null;
  spec: CourseSpec;
  humans: Client[];
  // --- while playing / showing results
  crew: CrewMember[];
  seats: (Client | null)[];
  sim: Sim | null;
  course: CourseDef | null;
  acc: number;
  sinceSnap: number;
  startedAt: number;
  deliveredT: number | null;
  // --- quick crews
  startsAt: number;
  lastCountdown: number;
  votes: Map<string, Set<string>>;
  banned: Set<string>;
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I / O
const SNAP_EVERY = 3; // 60 Hz sim → 20 Hz snapshots
const MAX_CATCHUP = 4;
const MAX_BUFFERED = 512 * 1024;
const BOT_HATS = ['chef', 'beanie', 'bucket', 'propeller'];
/** Upper bound on simulations stepping at once (each is ~0.25 ms per 60 Hz step). */
const MAX_RUNNING = Number(process.env.MAX_RUNNING_ROOMS ?? 200);

export const bracketFor = (stars: number) => (stars <= 8 ? 0 : stars <= 25 ? 1 : 2);

function botMember(slot: number, look?: Look): CrewMember {
  return {
    id: `bot${slot}`,
    name: botName(slot),
    look: look ?? sanitizeLook({ body: (slot * 4 + 2) % 12, shape: (slot + 1) % 2, hat: BOT_HATS[slot % BOT_HATS.length], rope: 'classic' }),
    bot: true,
  };
}

const member = (c: Client): CrewMember => ({ id: c.id, name: c.name, look: c.look, bot: false });

/** Accepts campaign courses and today's daily / this week's weekly course. */
export function validateSpec(spec: unknown): CourseSpec | null {
  if (!isObj(spec)) return null;
  const { biome, index, seed } = spec;
  if (typeof biome !== 'string' || !Object.prototype.hasOwnProperty.call(BIOMES, biome)) return null;
  if (Number.isInteger(index) && (index as number) >= 0 && (index as number) < BIOMES[biome as BiomeId].courses.length) return { biome: biome as BiomeId, index: index as number };
  for (const cur of [dailySpec(), weeklySpec()]) if (index === cur.index && seed === cur.seed && biome === cur.biome) return cur;
  return null;
}

function quickSpec(bracket: number): CourseSpec {
  if (bracket === 0) return { biome: 'kitchen', index: 0 };
  return { biome: BIOME_ORDER[randomInt(BIOME_ORDER.length)], index: randomInt(bracket === 1 ? 2 : 3) };
}

export class Game {
  readonly clients = new Set<Client>();
  readonly rooms = new Set<Room>();
  private reportsByIp = new Map<string, number>();
  private codes = new Map<string, Room>();
  private byId = new Map<string, Client>();
  private timer: NodeJS.Timeout | null = null;
  private last = 0;
  private uid = 0;

  constructor(
    private store: Store,
    private opts: GameOptions,
  ) {}

  // ------------------------------------------------------------------ connections

  runningRooms() {
    let n = 0;
    for (const r of this.rooms) if (r.state === 'playing') n++;
    return n;
  }

  /** Wire up a fresh socket; it becomes a Client once it says hello. */
  accept(ws: WebSocket, ip: string) {
    let client: Client | null = null;
    const helloTimer = setTimeout(() => !client && ws.close(4000, 'hello timeout'), 10_000);
    ws.on('message', (data: RawData, isBinary: boolean) => {
      if (isBinary) return;
      let m: unknown;
      try {
        m = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (!isObj(m) || typeof m.t !== 'string') return;
      if (!client) {
        if (m.t !== 'hello') return;
        clearTimeout(helloTimer);
        client = this.hello(ws, ip, m);
        return;
      }
      if (!client.msgs.take()) return;
      try {
        this.onMessage(client, m);
      } catch (e) {
        console.error('[ws] message handler failed:', e);
      }
    });
    ws.on('close', () => {
      clearTimeout(helloTimer);
      if (client) this.disconnect(client);
    });
    ws.on('error', () => {});
  }

  private hello(ws: WebSocket, ip: string, m: Record<string, unknown>): Client | null {
    if (m.v !== PROTOCOL_VERSION) {
      this.sendRaw(ws, { t: 'error', msg: 'The game was updated. Please refresh the page.' });
      ws.close(4001, 'protocol version');
      return null;
    }
    // A second tab with the same profile gets its own id so seats and votes stay unambiguous.
    const id = isHexId(m.id) && !this.byId.has(m.id) ? m.id : newId();
    const c: Client = {
      ws,
      ip,
      id,
      name: isSafeName(m.name) ? m.name : safeRandomName(),
      look: sanitizeLook(isObj(m.look) ? (m.look as Partial<Look>) : undefined),
      stars: Math.floor(clamp(finite(m.stars), 0, 10_000)),
      room: null,
      slot: -1,
      input: emptyInput(),
      syncInput: true,
      reports: 0,
      msgs: new Bucket(120, 100),
      pings: new Bucket(3, 3),
      social: new Bucket(2, 2),
      ctrl: new Bucket(10, 2),
    };
    this.clients.add(c);
    this.byId.set(id, c);
    this.send(c, { t: 'welcome', id, online: this.clients.size });
    return c;
  }

  private disconnect(c: Client) {
    this.leaveRoom(c);
    this.clients.delete(c);
    if (this.byId.get(c.id) === c) this.byId.delete(c.id);
  }

  private send(c: Client, m: ServerMsg) {
    this.sendRaw(c.ws, m);
  }

  private sendRaw(ws: WebSocket, m: ServerMsg | string) {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(typeof m === 'string' ? m : JSON.stringify(m));
  }

  private broadcast(room: Room, m: ServerMsg, except?: Client) {
    const text = JSON.stringify(m);
    for (const c of room.humans) if (c !== except) this.sendRaw(c.ws, text);
  }

  private error(c: Client, msg: string) {
    this.send(c, { t: 'error', msg });
  }

  // ------------------------------------------------------------------ messages

  private onMessage(c: Client, m: Record<string, unknown>) {
    const room = c.room;
    switch (m.t) {
      case 'input': {
        if (!room?.sim || c.slot < 0 || !isObj(m.input)) return;
        const i = m.input;
        const counter = (v: unknown) => Math.trunc(clamp(finite(v), 0, 1e9));
        c.input = { mx: clamp(finite(i.mx), -1, 1), up: !!i.up, down: !!i.down, grab: !!i.grab, jumpN: counter(i.jumpN), diveN: counter(i.diveN) };
        if (c.syncInput) {
          c.syncInput = false;
          const p = room.sim.players[c.slot];
          if (p) {
            p.lastJumpN = c.input.jumpN;
            p.lastDiveN = c.input.diveN;
          }
        }
        return;
      }
      case 'ping': {
        if (!room?.sim || c.slot < 0 || !(PINGS as readonly unknown[]).includes(m.kind)) return;
        if (typeof m.x !== 'number' || typeof m.y !== 'number' || !Number.isFinite(m.x) || !Number.isFinite(m.y)) return;
        if (!c.pings.take()) return;
        const b = room.course!.bounds;
        room.sim.ping(c.slot, m.kind as PingKind, clamp(m.x, b.minX - 5, b.maxX + 5), clamp(m.y, b.minY - 5, b.maxY + 5));
        return;
      }
      case 'emote': {
        if (!room?.sim || c.slot < 0 || !(EMOTES as readonly unknown[]).includes(m.kind)) return;
        if (!c.social.take()) return;
        room.sim.emote(c.slot, m.kind as EmoteKind);
        return;
      }
      case 'chat': {
        if (!room?.sim || c.slot < 0 || !Number.isInteger(m.i) || (m.i as number) < 0 || (m.i as number) >= QUICK_CHAT.length) return;
        if (!c.social.take()) return;
        room.sim.chat(c.slot, m.i as number);
        return;
      }
      default:
        break;
    }
    // Room management: slower, separately limited.
    if (!c.ctrl.take()) return;
    switch (m.t) {
      case 'quick':
        return this.quick(c);
      case 'create':
        return this.create(c);
      case 'join':
        return this.join(c, m.code);
      case 'leave':
        return this.leaveRoom(c);
      case 'course': {
        if (!room || room.mode !== 'friends' || room.state !== 'lobby' || room.hostId !== c.id) return;
        const spec = validateSpec(m.spec);
        if (!spec) return this.error(c, 'That course is not available.');
        room.spec = spec;
        return this.broadcastLobby(room);
      }
      case 'start':
        if (!room || room.mode !== 'friends' || room.state !== 'lobby') return;
        if (room.hostId !== c.id) return this.error(c, 'Only the host can start.');
        if (this.runningRooms() >= MAX_RUNNING) return this.error(c, 'The servers are full right now. Try again in a minute!');
        return this.startRun(room);
      case 'again':
        if (!room) return;
        if (room.mode === 'friends' && room.state === 'results') {
          room.state = 'lobby';
          room.crew = [];
          room.seats = [];
          room.votes.clear();
          return this.broadcastLobby(room);
        }
        return this.send(c, { t: 'lobby', lobby: this.lobbyState(room) });
      case 'votekick':
        return this.voteKick(c, m.target);
      case 'report':
        return this.report(c, m.target, m.reason);
      default:
        return;
    }
  }

  // ------------------------------------------------------------------ rooms

  private newRoom(mode: 'quick' | 'friends', bracket: number): Room {
    const room: Room = {
      uid: ++this.uid,
      mode,
      code: null,
      bracket,
      state: 'lobby',
      hostId: null,
      spec: mode === 'quick' ? quickSpec(bracket) : { biome: 'kitchen', index: 0 },
      humans: [],
      crew: [],
      seats: [],
      sim: null,
      course: null,
      acc: 0,
      sinceSnap: 0,
      startedAt: 0,
      deliveredT: null,
      startsAt: Date.now() + this.opts.quickWaitMs,
      lastCountdown: 0,
      votes: new Map(),
      banned: new Set(),
    };
    if (mode === 'friends') {
      let code: string;
      do code = Array.from({ length: 4 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
      while (this.codes.has(code));
      room.code = code;
      this.codes.set(code, room);
    }
    this.rooms.add(room);
    if (mode === 'quick') this.ensureLoop();
    return room;
  }

  private label(room: Room) {
    return room.code ?? `quick#${room.uid}`;
  }

  private destroy(room: Room) {
    if (room.sim) {
      if (this.opts.log) console.log(`[room ${this.label(room)}] end ${courseId(room.spec)} abandoned after ${((Date.now() - room.startedAt) / 1000).toFixed(0)}s`);
      room.sim.free();
      room.sim = null;
    }
    this.rooms.delete(room);
    if (room.code && this.codes.get(room.code) === room) this.codes.delete(room.code);
    for (const c of room.humans) if (c.room === room) c.room = null;
    room.humans = [];
  }

  lobbyState(room: Room): LobbyState {
    let members: CrewMember[];
    if (room.state !== 'lobby') members = room.crew;
    else {
      members = room.humans.map(member);
      if (room.mode === 'quick') for (let i = members.length; i < MAX_CREW; i++) members.push(botMember(i));
    }
    return {
      code: room.code,
      mode: room.mode,
      hostId: room.hostId,
      spec: room.spec,
      members,
      startsIn: room.mode === 'quick' && room.state === 'lobby' ? Math.max(0, Math.round((room.startsAt - Date.now()) / 100) / 10) : null,
      state: room.state,
    };
  }

  private broadcastLobby(room: Room) {
    this.broadcast(room, { t: 'lobby', lobby: this.lobbyState(room) });
  }

  private addHuman(room: Room, c: Client) {
    room.humans.push(c);
    c.room = room;
    c.slot = -1;
    if (room.mode === 'friends' && !room.hostId) room.hostId = c.id;
  }

  private create(c: Client) {
    this.leaveRoom(c);
    const room = this.newRoom('friends', bracketFor(c.stars));
    this.addHuman(room, c);
    room.hostId = c.id;
    this.broadcastLobby(room);
  }

  private join(c: Client, rawCode: unknown) {
    const code = typeof rawCode === 'string' ? rawCode.trim().toUpperCase() : '';
    const room = /^[A-Z]{4}$/.test(code) ? this.codes.get(code) : undefined;
    if (!room) return this.error(c, 'Room not found. Check the code?');
    if (c.room === room) return this.send(c, { t: 'lobby', lobby: this.lobbyState(room) });
    if (room.banned.has(c.id)) return this.error(c, "You can't rejoin that room.");
    if (room.state === 'playing') {
      const slot = this.openSeat(room);
      if (slot < 0) return this.error(c, 'That crew is mid-course with no free seat. Try again after this run.');
      this.leaveRoom(c);
      return this.takeSeat(room, c, slot);
    }
    if (room.humans.length >= MAX_CREW) return this.error(c, 'That room is full.');
    this.leaveRoom(c);
    this.addHuman(room, c);
    this.broadcastLobby(room);
  }

  /** A bot seat a newcomer can take over, or -1. */
  private openSeat(room: Room): number {
    if (room.state !== 'playing' || !room.sim || room.sim.status !== 'playing') return -1;
    if (Date.now() - room.startedAt > this.opts.maxRunMs * 0.9) return -1;
    return room.crew.findIndex((m) => m.bot);
  }

  private takeSeat(room: Room, c: Client, slot: number) {
    room.humans.push(c);
    c.room = room;
    room.seats[slot] = c;
    room.crew[slot] = member(c);
    room.sim!.setBot(slot, false);
    c.slot = slot;
    c.input = emptyInput();
    c.syncInput = true;
    room.sim!.setInput(slot, c.input);
    this.send(c, { t: 'start', spec: room.spec, slot, crew: room.crew });
    this.broadcast(room, { t: 'crew', crew: room.crew }, c);
    this.broadcastLobby(room);
  }

  private quick(c: Client) {
    this.leaveRoom(c);
    const bracket = bracketFor(c.stars);
    let target: Room | null = null;
    let seat = -1;
    for (const r of this.rooms) {
      if (r.mode !== 'quick' || r.bracket !== bracket || r.banned.has(c.id)) continue;
      if (r.state === 'lobby' && r.humans.length < MAX_CREW) {
        target = r;
        seat = -1;
        break;
      }
      if (!target && r.state === 'playing') {
        const s = this.openSeat(r);
        if (s >= 0) {
          target = r;
          seat = s;
        }
      }
    }
    if (target && seat >= 0) return this.takeSeat(target, c, seat);
    const room = target ?? this.newRoom('quick', bracket);
    this.addHuman(room, c);
    if (room.humans.length >= MAX_CREW && this.runningRooms() < MAX_RUNNING) this.startRun(room);
    else this.broadcastLobby(room);
  }

  /** Remove a player from their room: mid-run their seat is handed to a bot. */
  private leaveRoom(c: Client) {
    const room = c.room;
    if (!room) return;
    c.room = null;
    const slot = c.slot;
    c.slot = -1;
    room.humans = room.humans.filter((h) => h !== c);
    room.votes.delete(c.id);
    for (const v of room.votes.values()) v.delete(c.id);
    if (!room.humans.length) return this.destroy(room);
    if (room.hostId === c.id) room.hostId = room.mode === 'friends' ? room.humans[0].id : null;
    if (slot >= 0 && room.seats[slot] === c) {
      room.seats[slot] = null;
      room.crew[slot] = botMember(slot, room.crew[slot]?.look);
      if (room.state === 'playing' && room.sim) {
        room.sim.setBot(slot, true);
        this.broadcast(room, { t: 'crew', crew: room.crew });
      }
    }
    this.broadcastLobby(room);
  }

  // ------------------------------------------------------------------ runs

  private startRun(room: Room) {
    if (room.state === 'playing') return;
    let course: CourseDef;
    try {
      course = buildCourse(room.spec);
    } catch (e) {
      console.error('[room] course build failed', room.spec, e);
      room.spec = { biome: 'kitchen', index: 0 };
      course = buildCourse(room.spec);
    }
    const humans = room.humans.slice(0, MAX_CREW);
    const n = room.mode === 'quick' ? MAX_CREW : Math.min(MAX_CREW, Math.max(3, humans.length));
    room.crew = [];
    room.seats = [];
    for (let i = 0; i < n; i++) {
      const h = humans[i];
      room.crew.push(h ? member(h) : botMember(i));
      room.seats.push(h ?? null);
    }
    room.sim?.free();
    room.course = course;
    room.sim = new Sim(course, { crew: room.crew.map((m) => ({ bot: m.bot })) });
    room.state = 'playing';
    room.startedAt = Date.now();
    room.acc = 0;
    room.sinceSnap = 0;
    room.deliveredT = null;
    room.votes.clear();
    humans.forEach((h, slot) => {
      h.slot = slot;
      h.input = emptyInput();
      h.syncInput = true;
      this.send(h, { t: 'start', spec: room.spec, slot, crew: room.crew });
    });
    this.broadcastLobby(room);
    this.ensureLoop();
    if (this.opts.log) console.log(`[room ${this.label(room)}] start ${course.id} (${room.mode}) humans=${humans.length} bots=${n - humans.length}`);
  }

  private finishRun(room: Room, delivered: boolean) {
    const sim = room.sim!;
    const course = room.course!;
    const stars = delivered ? sim.starsFor() : 0;
    const collectibles = sim.collected.size;
    const result: RunResult = {
      courseId: course.id,
      courseName: course.name,
      stars,
      damage: Math.round(sim.damage),
      time: Math.round(sim.time * 10) / 10,
      par: course.parTime,
      collectibles,
      totalCollectibles: course.collectibles.length,
      coins: stars * 15 + collectibles * 5,
      crew: room.crew.map((m) => m.name),
    };
    if (delivered && room.spec.index < 0 && room.spec.seed !== undefined) {
      const key = `${room.spec.index === -1 ? 'd' : 'w'}${room.spec.seed}`;
      this.store.submitRun(key, { crew: result.crew, stars, time: Math.max(0.1, result.time), damage: Math.min(100, result.damage), at: Date.now() });
    }
    sim.free();
    room.sim = null;
    room.state = 'results';
    for (const h of room.humans) if (h.slot >= 0) this.send(h, { t: 'result', result });
    for (const h of room.humans) h.slot = -1;
    room.seats = [];
    this.broadcastLobby(room);
    if (this.opts.log)
      console.log(`[room ${this.label(room)}] end ${course.id} ${delivered ? 'delivered' : 'timed out'} stars=${stars} time=${result.time}s dmg=${result.damage} humans=${room.humans.length}`);
  }

  // ------------------------------------------------------------------ moderation

  private voteKick(c: Client, targetId: unknown) {
    const room = c.room;
    if (!room || typeof targetId !== 'string' || targetId === c.id) return;
    const target = room.humans.find((h) => h.id === targetId);
    if (!target) return;
    const others = room.humans.length - 1;
    if (others < 2) return this.error(c, 'Vote kicks need at least 3 players in the crew.');
    const needed = Math.max(2, Math.floor(others / 2) + 1);
    let votes = room.votes.get(target.id);
    if (!votes) room.votes.set(target.id, (votes = new Set()));
    votes.add(c.id);
    this.broadcast(room, { t: 'votekick', target: target.name, votes: votes.size, needed });
    if (votes.size >= needed) {
      room.banned.add(target.id);
      this.send(target, { t: 'kicked', reason: 'The crew voted to remove you.' });
      this.leaveRoom(target);
    }
  }

  private report(c: Client, targetId: unknown, reason: unknown) {
    if (typeof targetId !== 'string' || targetId.length > 64 || c.reports >= 20) return;
    // Reports are capped per address too, so reconnecting can't flood the log.
    const perIp = (this.reportsByIp.get(c.ip) ?? 0) + 1;
    if (perIp > 50) return;
    this.reportsByIp.set(c.ip, perIp);
    const room = c.room;
    const who = room?.humans.find((h) => h.id === targetId) ?? room?.crew.find((m) => m.id === targetId);
    c.reports++;
    this.store.reports.push({
      at: new Date().toISOString(),
      reporter: c.id,
      target: targetId,
      targetName: who?.name ?? null,
      reason: typeof reason === 'string' ? reason.slice(0, 40) : '',
      room: room ? this.label(room) : null,
    });
  }

  // ------------------------------------------------------------------ loop

  private ensureLoop() {
    if (this.timer) return;
    this.last = performance.now();
    this.timer = setInterval(() => this.tick(), 1000 / 60);
  }

  private tick() {
    const now = performance.now();
    const dt = Math.min(0.25, (now - this.last) / 1000);
    this.last = now;
    const wall = Date.now();
    let active = 0;
    for (const room of this.rooms) {
      if (room.state === 'playing' && room.sim) {
        active++;
        try {
          this.stepRoom(room, dt, wall);
        } catch (e) {
          console.error(`[room ${this.label(room)}] step failed, ending run`, e);
          if (room.sim) this.finishRun(room, false);
        }
      } else if (room.mode === 'quick' && room.state === 'lobby') {
        active++;
        if (wall >= room.startsAt && this.runningRooms() < MAX_RUNNING) this.startRun(room);
        else if (wall - room.lastCountdown >= 1000) {
          room.lastCountdown = wall;
          this.broadcastLobby(room);
        }
      }
    }
    if (!active && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private stepRoom(room: Room, dt: number, wall: number) {
    const sim = room.sim!;
    room.acc += dt;
    let steps = 0;
    while (room.acc >= DT && steps < MAX_CATCHUP) {
      for (let s = 0; s < room.seats.length; s++) {
        const c = room.seats[s];
        if (c) sim.setInput(s, c.input);
      }
      sim.step();
      room.acc -= DT;
      steps++;
    }
    if (room.acc > DT) room.acc = DT; // don't spiral: drop what we couldn't catch up on
    room.sinceSnap += steps;
    if (room.sinceSnap >= SNAP_EVERY) {
      room.sinceSnap = 0;
      const text = JSON.stringify({ t: 'snap', s: sim.snapshot() } satisfies ServerMsg);
      for (const c of room.humans) if (c.slot >= 0 && c.ws.bufferedAmount < MAX_BUFFERED) this.sendRaw(c.ws, text);
    }
    if (sim.status === 'delivered') {
      if (room.deliveredT === null) room.deliveredT = sim.t;
      if (sim.t - room.deliveredT >= this.opts.resultDelayMs / 1000) this.finishRun(room, true);
    } else if (wall - room.startedAt > this.opts.maxRunMs) this.finishRun(room, false);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const room of [...this.rooms]) this.destroy(room);
  }
}
