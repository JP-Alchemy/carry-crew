import { initPhysics, Sim } from '../src/shared/sim';
import { buildCourse } from '../src/shared/courses';
await initPhysics();
const sim = new Sim(buildCourse({ biome: 'kitchen', index: 0 }), { crew: [{ bot: true }, { bot: true }, { bot: true }] });
const until = Number(process.argv[2] ?? 55);
while (sim.t < until) { sim.step(); sim.snapshot(); }
for (let k = 0; k < 5; k++) {
  sim.step();
  const ev = sim.snapshot().events.filter(e => e.e !== 'land');
  const c = sim.cargo[0].body;
  console.log('cargo', c.translation(), 'rot', c.rotation().toFixed(2));
  sim.players.forEach((p, i) => console.log(i, JSON.stringify(p.input), 'pos', p.body.translation().x.toFixed(2), p.body.translation().y.toFixed(2), 'v', p.body.linvel().x.toFixed(2), 'g', p.grounded, 'onC', p.onCargo, 'grab', p.grab?.kind, 'face', p.facing, 'st', p.stamina.toFixed(1), 'rg', p.regrabCd.toFixed(2)));
  console.log(ev);
}
