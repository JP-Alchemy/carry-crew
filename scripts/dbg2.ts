import RAPIER from '@dimforge/rapier2d-compat';
import { initPhysics, Sim } from '../src/shared/sim';
import { buildCourse } from '../src/shared/courses';
await initPhysics();
const sim = new Sim(buildCourse({ biome: 'kitchen', index: 0 }), { crew: [{ bot: true }, { bot: true }, { bot: true }] });
while (sim.t < 170) { sim.step(); sim.snapshot(); }
const p = sim.players[1];
const c = p.body.translation();
console.log('p1', c, 'grab', p.grab?.kind, 'cargo', sim.cargoPos(), 'rot', sim.cargo[0].body.rotation());
for (const r of [0.3, 0.52, 0.8]) {
  const hits: string[] = [];
  sim.world.intersectionsWithShape(c, 0, new RAPIER.Ball(r), (col) => { const inf = sim.info.get(col.handle); hits.push(`${inf?.kind}${inf?.j ?? ''}`); return true; });
  console.log(r, hits.join(' '));
}
