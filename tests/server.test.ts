import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { dailySpec } from '../src/shared/courses';
import { PROTOCOL_VERSION, type ServerMsg } from '../src/shared/protocol';
import { startServer, type RunningServer } from '../src/server/server';

type Msg<T extends ServerMsg['t']> = Extract<ServerMsg, { t: T }>;

const hexId = () => randomBytes(8).toString('hex');

/** Minimal test client: buffers every server message so tests can await specific ones. */
class TestClient {
  ws: WebSocket;
  msgs: ServerMsg[] = [];
  private waiters: { pred: (m: ServerMsg) => boolean; resolve: (m: ServerMsg) => void }[] = [];
  private opened: Promise<void>;

  constructor(port: number) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    this.opened = new Promise((res, rej) => {
      this.ws.once('open', () => res());
      this.ws.once('error', rej);
    });
    this.ws.on('message', (data) => {
      const m = JSON.parse(data.toString()) as ServerMsg;
      this.msgs.push(m);
      for (const w of [...this.waiters]) {
        if (w.pred(m)) {
          this.waiters.splice(this.waiters.indexOf(w), 1);
          w.resolve(m);
        }
      }
    });
  }

  send(m: unknown) {
    this.ws.send(JSON.stringify(m));
  }

  /** Resolve with the first message (already received, or future) of type `t` matching `pred`. */
  next<T extends ServerMsg['t']>(t: T, pred: (m: Msg<T>) => boolean = () => true, timeoutMs = 4000, since = 0): Promise<Msg<T>> {
    const match = (m: ServerMsg) => m.t === t && pred(m as Msg<T>);
    const have = this.msgs.slice(since).find(match);
    if (have) return Promise.resolve(have as Msg<T>);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for '${t}'`)), timeoutMs);
      this.waiters.push({
        pred: match,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m as Msg<T>);
        },
      });
    });
  }

  /** Wait for a message that arrives after this call. */
  after<T extends ServerMsg['t']>(t: T, pred?: (m: Msg<T>) => boolean, timeoutMs?: number) {
    return this.next(t, pred, timeoutMs, this.msgs.length);
  }

  async open() {
    await this.opened;
  }

  async hello(opts: { id?: string; name?: string; stars?: number; v?: number } = {}) {
    await this.opened;
    this.send({ t: 'hello', v: opts.v ?? PROTOCOL_VERSION, id: opts.id ?? hexId(), name: opts.name ?? 'Wobbly Muffin', look: { body: 1, shape: 0, hat: 'party', rope: 'classic' }, stars: opts.stars ?? 0 });
    return this.next('welcome');
  }

  close() {
    this.ws.close();
  }
}

describe('game server', () => {
  let srv: RunningServer;
  let dataDir: string;
  let base: string;
  const clients: TestClient[] = [];
  const client = () => {
    const c = new TestClient(srv.port);
    clients.push(c);
    return c;
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'carry-crew-test-'));
    srv = await startServer({ port: 0, host: '127.0.0.1', dataDir, quickWaitMs: 400, quiet: true });
    base = `http://127.0.0.1:${srv.port}`;
  });

  afterAll(async () => {
    clients.forEach((c) => c.close());
    await srv.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('reports health', async () => {
    const r = await fetch(`${base}/api/health`);
    expect(r.status).toBe(200);
    expect(r.headers.get('access-control-allow-origin')).toBe('*');
    const j = await r.json();
    expect(j.ok).toBe(true);
    expect(typeof j.online).toBe('number');
    expect(typeof j.rooms).toBe('number');
  });

  it('answers CORS preflight on /api', async () => {
    const r = await fetch(`${base}/api/events`, { method: 'OPTIONS' });
    expect(r.status).toBe(204);
    expect(r.headers.get('access-control-allow-methods')).toContain('POST');
  });

  it('handshakes hello → welcome and sanitises identity', async () => {
    const a = client();
    const id = hexId();
    const w = await a.hello({ id });
    expect(w.id).toBe(id);
    expect(w.online).toBeGreaterThanOrEqual(1);

    const b = client();
    const w2 = await b.hello({ id: 'not-an-id', name: 'Evil Name' });
    expect(w2.id).toMatch(/^[0-9a-f]{16}$/);

    const old = client();
    await old.open();
    old.send({ t: 'input', input: {} }); // ignored before hello
    old.send({ t: 'hello', v: PROTOCOL_VERSION + 99, id: hexId(), name: 'Tiny Bean', look: {}, stars: 0 });
    expect((await old.next('error')).msg).toMatch(/refresh/i);
  });

  it('runs a friends room: create, join by code, start, snapshots, disconnect → bot', async () => {
    const host = client();
    const guest = client();
    const hostHello = await host.hello({ name: 'Brave Otter' });
    await guest.hello({ name: 'Sleepy Panda' });

    host.send({ t: 'create' });
    const l1 = await host.next('lobby');
    expect(l1.lobby.code).toMatch(/^[A-Z]{4}$/);
    expect(l1.lobby.hostId).toBe(hostHello.id);
    expect(l1.lobby.mode).toBe('friends');

    guest.send({ t: 'join', code: l1.lobby.code!.toLowerCase() });
    await guest.next('lobby', (m) => m.lobby.members.length === 2);
    await host.next('lobby', (m) => m.lobby.members.length === 2);

    // Non-hosts can't start; bad course specs are refused.
    guest.send({ t: 'start' });
    await guest.next('error');
    host.send({ t: 'course', spec: { biome: 'kitchen', index: 7 } });
    await host.next('error', (m) => /course/i.test(m.msg));
    host.send({ t: 'course', spec: { biome: 'bedroom', index: 1 } });
    await guest.next('lobby', (m) => m.lobby.spec.biome === 'bedroom');

    host.send({ t: 'start' });
    const [sh, sg] = await Promise.all([host.next('start'), guest.next('start')]);
    expect(sh.slot).not.toBe(sg.slot);
    expect(sh.crew).toHaveLength(3); // 2 humans + 1 bot
    expect(sh.crew.filter((m) => m.bot)).toHaveLength(1);
    expect(sh.spec).toEqual({ biome: 'bedroom', index: 1 });

    // Inputs (including junk) are accepted without breaking anything.
    guest.send({ t: 'input', input: { mx: 99, up: 'yes', down: 0, grab: null, jumpN: 3.7, diveN: -5 } });
    guest.send({ t: 'chat', i: 999 });
    guest.send({ t: 'chat', i: 1 });
    guest.send('garbage');

    const snaps = await Promise.all([host.after('snap'), guest.after('snap')]);
    expect(snaps[0].s.players).toHaveLength(3);
    const chat = await host.next('snap', (m) => m.s.events.some((e) => e.e === 'chat'));
    expect(chat.s.events.find((e) => e.e === 'chat')).toMatchObject({ p: sg.slot, i: 1 });

    guest.close();
    const crew = await host.next('crew');
    expect(crew.crew[sg.slot].bot).toBe(true);
    expect(crew.crew[sg.slot].name).toMatch(/\(bot\)$/);
    expect(crew.crew[sh.slot].bot).toBe(false);

    // A newcomer joining mid-run takes over the bot seat.
    const late = client();
    await late.hello({ name: 'Tiny Goose' });
    late.send({ t: 'join', code: l1.lobby.code });
    const sl = await late.next('start');
    expect(sl.crew[sl.slot]).toMatchObject({ name: 'Tiny Goose', bot: false });
    await late.after('snap');
    await host.next('crew', (m) => m.crew.some((c) => c.name === 'Tiny Goose'));

    host.close();
    late.close();
  });

  it('errors on unknown room codes', async () => {
    const c = client();
    await c.hello();
    c.send({ t: 'join', code: 'ZZZZ' });
    expect((await c.next('error')).msg).toMatch(/not found/i);
  });

  it('starts a quick crew after the countdown with bots filling 4 seats, and seats late joiners', async () => {
    const a = client();
    await a.hello({ stars: 12, name: 'Jolly Bean' });
    a.send({ t: 'quick' });
    const lobby = await a.next('lobby');
    expect(lobby.lobby.mode).toBe('quick');
    expect(lobby.lobby.code).toBeNull();
    expect(lobby.lobby.startsIn).not.toBeNull();
    expect(lobby.lobby.startsIn!).toBeLessThanOrEqual(0.4);

    const start = await a.next('start', undefined, 3000);
    expect(start.crew).toHaveLength(4);
    expect(start.crew.filter((m) => m.bot)).toHaveLength(3);
    expect(start.spec.index).toBeGreaterThanOrEqual(0);
    expect(start.spec.index).toBeLessThanOrEqual(1); // bracket 1
    await a.after('snap');

    // Same bracket, room already playing: take over a bot seat.
    const b = client();
    await b.hello({ stars: 20, name: 'Lucky Llama' });
    b.send({ t: 'quick' });
    const sb = await b.next('start');
    expect(sb.slot).not.toBe(start.slot);
    expect(sb.crew[sb.slot]).toMatchObject({ name: 'Lucky Llama', bot: false });
    expect(sb.spec).toEqual(start.spec);
    await b.after('snap');
    await a.next('crew', (m) => m.crew.filter((c) => !c.bot).length === 2);
    a.close();
    b.close();
  });

  it('vote-kicks with a majority of the other players', async () => {
    const [a, b, c] = [client(), client(), client()];
    await a.hello({ name: 'Mighty Walrus' });
    await b.hello({ name: 'Zippy Gecko' });
    const wc = await c.hello({ name: 'Sneaky Badger' });
    a.send({ t: 'create' });
    const code = (await a.next('lobby')).lobby.code!;
    b.send({ t: 'join', code });
    c.send({ t: 'join', code });
    await a.next('lobby', (m) => m.lobby.members.length === 3);
    a.send({ t: 'start' });
    const sc = await c.next('start');
    expect(sc.crew).toHaveLength(3);

    c.send({ t: 'votekick', target: wc.id }); // can't vote for yourself: ignored
    a.send({ t: 'votekick', target: wc.id });
    const v1 = await b.next('votekick');
    expect(v1).toMatchObject({ target: 'Sneaky Badger', votes: 1, needed: 2 });
    b.send({ t: 'votekick', target: wc.id });
    expect((await c.next('kicked')).reason).toBeTruthy();
    const crew = await a.next('crew');
    expect(crew.crew[sc.slot].bot).toBe(true);

    c.send({ t: 'join', code });
    expect((await c.after('error')).msg).toMatch(/rejoin/i);

    b.send({ t: 'report', target: wc.id, reason: 'griefing'.repeat(10) });
    [a, b, c].forEach((x) => x.close());
  });

  it('daily leaderboard: submit + board roundtrip, rejects wrong key', async () => {
    const key = `d${dailySpec().seed}`;
    const bad = await fetch(`${base}/api/daily/submit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: 'd19990101', crew: ['Brave Otter'], stars: 3, time: 50, damage: 1 }) });
    expect(bad.status).toBe(400);

    const post = (body: unknown) => fetch(`${base}/api/daily/submit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
    const r1 = await post({ key, crew: ['Brave Otter', 'Botty (bot)', '<script>'], stars: 2, time: 80.04, damage: 20 });
    expect(r1).toEqual({ ok: true, rank: 1 });
    const r2 = await post({ key, crew: ['Sleepy Panda'], stars: 9, time: 60, damage: -5 });
    expect(r2).toEqual({ ok: true, rank: 1 });

    const board = await fetch(`${base}/api/daily/board?key=${key}`).then((r) => r.json());
    expect(board.entries).toHaveLength(2);
    expect(board.entries[0]).toEqual({ crew: ['Sleepy Panda'], stars: 3, time: 60, damage: 0 });
    expect(board.entries[1]).toEqual({ crew: ['Brave Otter', 'Botty (bot)'], stars: 2, time: 80, damage: 20 });

    const empty = await fetch(`${base}/api/daily/board?key=d20000101`).then((r) => r.json());
    expect(empty.entries).toEqual([]);
  });

  it('credits invites once per new player', async () => {
    const ref = hexId();
    const post = (body: unknown) => fetch(`${base}/api/invites/credit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const a = hexId();
    const b = hexId();
    expect((await post({ ref, id: a })).status).toBe(200);
    expect((await post({ ref, id: a })).status).toBe(200); // duplicate: no double credit
    expect((await post({ ref: hexId(), id: a })).status).toBe(200); // someone else can't claim them either
    expect((await post({ ref, id: b })).status).toBe(200);
    expect((await post({ ref, id: 'nope' })).status).toBe(400);
    const r = await fetch(`${base}/api/invites/${ref}`).then((x) => x.json());
    expect(r).toEqual({ friends: 2 });
    const none = await fetch(`${base}/api/invites/${hexId()}`).then((x) => x.json());
    expect(none).toEqual({ friends: 0 });
  });

  it('accepts analytics beacons (text/plain) and strips non-primitive props', async () => {
    const r = await fetch(`${base}/api/events`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify({ id: hexId(), events: [{ e: 'session_start', t: 1, p: { n: 1, ok: true, s: 'x', bad: { deep: 1 } } }, { nope: 1 }] }),
    });
    expect(await r.json()).toEqual({ ok: true });
    const big = await fetch(`${base}/api/events`, { method: 'POST', body: 'x'.repeat(70 * 1024) });
    expect(big.status).toBe(413);
  });
});

describe('run lifecycle', () => {
  it('times out a run with 0 stars, persists data, then returns to the lobby on again', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'carry-crew-test-'));
    const srv = await startServer({ port: 0, host: '127.0.0.1', dataDir, maxRunMs: 300, quiet: true });
    const a = new TestClient(srv.port);
    try {
      await a.hello({ name: 'Humble Puffin' });
      a.send({ t: 'create' });
      await a.next('lobby');
      a.send({ t: 'start' });
      const s = await a.next('start');
      expect(s.crew).toHaveLength(3); // solo human still gets a crew of 3
      const res = await a.next('result', undefined, 3000);
      expect(res.result).toMatchObject({ courseId: 'kitchen-1', stars: 0, totalCollectibles: expect.any(Number) });
      expect(res.result.crew).toHaveLength(3);
      await a.next('lobby', (m) => m.lobby.state === 'results');
      a.send({ t: 'again' });
      await a.next('lobby', (m) => m.lobby.state === 'lobby');

      a.send({ t: 'report', target: '0123456789abcdef', reason: 'x'.repeat(100) });
      await fetch(`http://127.0.0.1:${srv.port}/api/invites/credit`, { method: 'POST', body: JSON.stringify({ ref: '0123456789abcdef', id: 'fedcba9876543210' }) });
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      a.close();
      await srv.close();
    }
    const report = JSON.parse(readFileSync(join(dataDir, 'reports.jsonl'), 'utf8').trim());
    expect(report).toMatchObject({ target: '0123456789abcdef', reason: 'x'.repeat(40) });
    expect(JSON.parse(readFileSync(join(dataDir, 'invites.json'), 'utf8')).counts).toEqual({ '0123456789abcdef': 1 });
    rmSync(dataDir, { recursive: true, force: true });
  });
});
