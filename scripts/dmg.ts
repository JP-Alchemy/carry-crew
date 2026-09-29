import { initPhysics, Sim } from '../src/shared/sim';
import { buildCourse } from '../src/shared/courses';
await initPhysics();
const [biome, idx] = (process.argv[2] ?? 'kitchen-1').split('-');
const course = buildCourse({ biome: biome as 'kitchen', index: Number(idx) - 1 });
const sim = new Sim(course, { crew: [{ bot: true }, { bot: true }, { bot: true }] });
for (let k = 0; k < 300 * 60 && sim.status === 'playing'; k++) {
  sim.step();
  for (const e of sim.snapshot().events) {
    if (e.e === 'damage' || e.e === 'ouch' || e.e === 'slip' || e.e === 'reset') {
      const x = 'x' in e ? e.x : sim.players[(e as { p: number }).p]?.body.translation().x ?? 0;
      const sec = course.sections.find((q) => x >= q.x0 && x < q.x1);
      console.log(sim.time.toFixed(1), e.e, 'amount' in e ? e.amount : 'kind' in e ? e.kind : '', `${sec?.name}+${sec ? (x - sec.x0).toFixed(1) : ''}`);
    }
  }
}
console.log(sim.status, sim.damage.toFixed(0));
