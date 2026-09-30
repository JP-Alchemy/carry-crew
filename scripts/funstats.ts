// How much slapstick happens in a bot run? (tumbles, boings, knocks per minute)
import { initPhysics, Sim } from '../src/shared/sim';
import { allCampaignSpecs, buildCourse } from '../src/shared/courses';
await initPhysics();
for (const spec of allCampaignSpecs()) {
  const c = buildCourse(spec);
  const sim = new Sim(c, { crew: [{ bot: true }, { bot: true }, { bot: true }] });
  const n: Record<string, number> = {};
  for (let k = 0; k < 60 * 180 && sim.status === 'playing'; k++) {
    sim.step();
    for (const e of sim.snapshot().events) {
      const key = e.e === 'tumble' ? 'tumble-' + e.kind : e.e;
      if (['tumble-yank', 'tumble-land', 'boing', 'ouch', 'fell', 'slip', 'panic'].includes(key)) n[key] = (n[key] ?? 0) + 1;
    }
  }
  const mins = sim.time / 60;
  console.log(c.id.padEnd(13), sim.status.padEnd(9), sim.time.toFixed(0).padStart(4) + 's', Object.entries(n).map(([k, v]) => `${k}:${(v / mins).toFixed(1)}/min`).join(' '));
  sim.free();
}
