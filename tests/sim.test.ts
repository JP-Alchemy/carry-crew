import { beforeAll, describe, expect, it } from 'vitest';
import { PLAYER_R } from '../src/shared/constants';
import { BIOME_ORDER, allCampaignSpecs, buildCourse, buildTestCourse, courseId, dailySpec, weeklySpec } from '../src/shared/courses';
import { isSafeName, randomName } from '../src/shared/names';
import { initPhysics, Sim } from '../src/shared/sim';
import { emptyInput, type CourseDef } from '../src/shared/types';

beforeAll(async () => {
  await initPhysics();
});

const bots = (n: number) => ({ crew: Array.from({ length: n }, () => ({ bot: true })) });

function run(sim: Sim, seconds: number, onStep?: () => void) {
  const events: string[] = [];
  for (let k = 0; k < seconds * 60 && sim.status === 'playing'; k++) {
    sim.step();
    onStep?.();
    for (const e of sim.snapshot().events) events.push(e.e);
  }
  return events;
}

describe('courses', () => {
  const specs = [...allCampaignSpecs(), dailySpec(new Date('2026-09-29T12:00:00Z')), weeklySpec(new Date('2026-09-29T12:00:00Z'))];

  it.each(specs.map((s) => [courseId(s), s] as const))('%s is well formed', (_id, spec) => {
    const c: CourseDef = buildCourse(spec);
    expect(c.checkpoints.length).toBeGreaterThanOrEqual(5);
    for (let i = 1; i < c.checkpoints.length; i++) expect(c.checkpoints[i].x).toBeGreaterThan(c.checkpoints[i - 1].x);
    expect(c.goal.x).toBeGreaterThan(c.checkpoints[c.checkpoints.length - 1].x);
    expect(c.cargoStart.x).toBeGreaterThan(c.checkpoints[0].x);
    expect(c.parTime).toBeGreaterThan(60);
    for (const s of c.solids) for (const v of [s.x, s.y, s.w, s.h]) expect(Number.isFinite(v)).toBe(true);
  });

  it('builds the same course from the same spec (deterministic for every client)', () => {
    const a = buildCourse(dailySpec(new Date('2026-01-02T00:00:00Z')));
    const b = buildCourse(dailySpec(new Date('2026-01-02T00:00:00Z')));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('gives each biome three courses of rising difficulty', () => {
    for (const biome of BIOME_ORDER) {
      const d = [0, 1, 2].map((index) => buildCourse({ biome, index }));
      expect(d.map((c) => c.difficulty)).toEqual([0, 1, 2]);
      expect(d[2].checkpoints.length).toBeGreaterThan(d[0].checkpoints.length);
    }
  });
});

describe('simulation', () => {
  it('stays stable with a full crew on every campaign course', () => {
    for (const spec of allCampaignSpecs()) {
      const sim = new Sim(buildCourse(spec), bots(4));
      run(sim, 8);
      for (const p of sim.players) {
        const t = p.body.translation();
        expect(Number.isFinite(t.x) && Number.isFinite(t.y)).toBe(true);
      }
      // The rope never stretches much beyond its length.
      for (let i = 0; i + 1 < sim.players.length; i++) {
        const a = sim.players[i].body.translation();
        const b = sim.players[i + 1].body.translation();
        expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeLessThan(sim.ropeLength * 1.1);
      }
      sim.free();
    }
  });

  it('bots alone deliver the cake on the first kitchen course', () => {
    const sim = new Sim(buildCourse({ biome: 'kitchen', index: 0 }), bots(3));
    const events = run(sim, 240);
    expect(sim.status).toBe('delivered');
    expect(events).toContain('checkpoint');
    expect(events).toContain('delivered');
    expect(sim.starsFor()).toBeGreaterThanOrEqual(1);
    sim.free();
  });

  it('a player can walk, jump and grab the cargo', () => {
    const sim = new Sim(buildCourse({ biome: 'kitchen', index: 0 }), { crew: [{ bot: false }] });
    const p = sim.players[0];
    const x0 = p.body.translation().x;
    run(sim, 0.5);
    sim.setInput(0, { ...emptyInput(), mx: 1 });
    run(sim, 1);
    expect(p.body.translation().x).toBeGreaterThan(x0 + 2);
    // Jump
    const yGround = p.body.translation().y;
    let maxY = yGround;
    sim.setInput(0, { ...emptyInput(), jumpN: 1 });
    run(sim, 0.5, () => (maxY = Math.max(maxY, p.body.translation().y)));
    expect(maxY).toBeGreaterThan(yGround + 1);
    // Walk up to the cake and grab it
    run(sim, 1);
    for (let k = 0; k < 600 && !p.grab; k++) {
      const dx = sim.cargoPos().x - p.body.translation().x;
      sim.setInput(0, { ...emptyInput(), jumpN: 1, mx: Math.sign(dx), grab: Math.abs(dx) < 1.4 });
      sim.step();
    }
    expect(p.grab?.kind).toBe('cargo');
    // A solo crew can lift it
    run(sim, 1);
    expect(sim.cargoPos().y).toBeGreaterThan(p.body.translation().y);
    sim.free();
  });

  it('dropping the cargo into the abyss resets the crew at the checkpoint with damage', () => {
    const sim = new Sim(buildTestCourse('kitchen', ['kSink'], 0), bots(2));
    run(sim, 0.2);
    const cargo = sim.cargo[0].body;
    cargo.setTranslation({ x: sim.course.cargoStart.x + 3, y: -9 }, true);
    const events = run(sim, 0.5);
    expect(events).toContain('drop');
    expect(events).toContain('reset');
    expect(sim.damage).toBeGreaterThan(5);
    expect(sim.cargoPos().y).toBeGreaterThan(-1);
  });

  it('hard landings hurt the cargo, gentle ones do not', () => {
    const sim = new Sim(buildCourse({ biome: 'kitchen', index: 0 }), bots(1));
    sim.setBot(0, false);
    run(sim, 1);
    expect(sim.damage).toBe(0);
    const c = sim.cargo[0].body;
    const t = c.translation();
    c.setTranslation({ x: t.x, y: t.y + 3 }, true);
    run(sim, 1.5);
    expect(sim.damage).toBeGreaterThan(3);
  });

  it('snapshots carry everything the renderer needs', () => {
    const sim = new Sim(buildCourse({ biome: 'playground', index: 1 }), bots(4));
    run(sim, 1);
    const s = sim.snapshot();
    expect(s.players).toHaveLength(4);
    expect(s.rope).toHaveLength(3);
    expect(s.rope[0].length % 2).toBe(0);
    expect(s.movers.length).toBe(sim.course.movers.length * 3);
    expect(s.props.length).toBe(sim.course.props.length * 3);
    expect(s.cargo.parts.length).toBe(3);
    expect(JSON.stringify(JSON.parse(JSON.stringify(s)))).toBe(JSON.stringify(s));
    expect(s.players[0].y).toBeGreaterThan(-5 + PLAYER_R);
  });

  it('plates twist: plates fall off and count as damage', () => {
    const course = buildCourse({ biome: 'kitchen', index: 0 });
    course.cargo = 'plates';
    const sim = new Sim(course, bots(1));
    sim.setBot(0, false);
    run(sim, 0.5);
    expect(sim.cargo).toHaveLength(6);
    const tray = sim.cargo[0].body.translation();
    sim.cargo[3].body.setTranslation({ x: tray.x - 2.5, y: tray.y + 0.2 }, true);
    const events = run(sim, 0.5);
    expect(events).toContain('layer');
    expect(sim.damage).toBeGreaterThan(10);
  });
});

describe('safety', () => {
  it('only generates names from the safe word lists', () => {
    for (let i = 0; i < 200; i++) expect(isSafeName(randomName(i))).toBe(true);
    expect(isSafeName('Wobbly <script>')).toBe(false);
    expect(isSafeName('anything else')).toBe(false);
  });
});
