import { initPhysics, Sim } from '../src/shared/sim';
import { buildCourse } from '../src/shared/courses';
await initPhysics();
const course = buildCourse({ biome: 'kitchen', index: 0 });
course.cargo = 'plates';
const sim = new Sim(course, { crew: [{ bot: false }] });
for (let i = 0; i < 30; i++) { sim.step(); sim.snapshot(); }
console.log(sim.cargo.map(c => [c.body.translation().x.toFixed(2), c.body.translation().y.toFixed(2)]));
sim.cargo[0].body.setLinvel({ x: 12, y: 0 }, true);
for (let i = 0; i < 90; i++) { sim.step(); const e = sim.snapshot().events; if (e.length) console.log(i, e); }
console.log(sim.cargo.map(c => [c.body.translation().x.toFixed(2), c.body.translation().y.toFixed(2), c.alive]));
