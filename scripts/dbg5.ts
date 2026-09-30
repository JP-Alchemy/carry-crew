import { initPhysics, Sim } from '../src/shared/sim';
import { buildTestCourse } from '../src/shared/courses';
await initPhysics();
const c = buildTestCourse(process.argv[2] as 'kitchen' ?? 'kitchen', [process.argv[3] ?? 'kLaunch'], 0);
const sim = new Sim(c, { crew: [{ bot: true }, { bot: true }, { bot: true }] });
const x0 = c.sections[1].x0;
let fired = -1;
for (let k = 0; k < 60 * 20; k++) {
  sim.step();
  const ev = sim.snapshot().events;
  if (ev.some((e) => e.e === 'boing')) fired = k;
  if (fired >= 0 && k - fired < 80 && (k - fired) % 8 === 0) {
    const ct = sim.cargoPos(); const cv = sim.cargo[0].body.linvel();
    console.log((k - fired), 'cargo', (ct.x - x0).toFixed(1), ct.y.toFixed(1), 'v', cv.x.toFixed(1), cv.y.toFixed(1), sim.players.map((p) => `${(p.body.translation().x - x0).toFixed(1)},${p.body.translation().y.toFixed(1)} v${p.body.linvel().x.toFixed(1)},${p.body.linvel().y.toFixed(1)} ${p.grab?.kind ?? ''} mx${p.input.mx}`).join(' | '));
  }
  if (fired >= 0 && k - fired > 80) break;
}
