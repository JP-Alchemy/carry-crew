import { initPhysics, Sim } from '../src/shared/sim';
import { buildTestCourse } from '../src/shared/courses';
await initPhysics();
const c = buildTestCourse('bedroom', ['bBed'], 0);
console.log(c.zones.filter(z => z.kind === 'kill'), c.killY);
const sim = new Sim(c, { crew: [{ bot: true }, { bot: true }, { bot: true }] });
while (sim.t < 24) { sim.step(); sim.snapshot(); }
sim.players.forEach((p, i) => console.log(i, p.body.translation(), 'killT', p.killT, p.grab?.kind));
