import { initPhysics, Sim } from '../src/shared/sim';
import { BIOME_ORDER, buildTestCourse, piecesOf } from '../src/shared/courses';
import type { BiomeId } from '../src/shared/types';

await initPhysics();
const only = process.argv[2];
const crew = Number(process.argv[3] ?? 3);
for (const biome of BIOME_ORDER as BiomeId[]) {
  for (const piece of piecesOf(biome)) {
    if (only && !piece.startsWith(only)) continue;
    const row: string[] = [];
    for (const d of process.env.D ? [Number(process.env.D)] : [0, 1, 2]) {
      const course = buildTestCourse(biome, [piece], d);
      const sim = new Sim(course, { crew: Array.from({ length: crew }, () => ({ bot: true })) });
      let resets = 0;
      for (let k = 0; k < 150 * 60 && sim.status === 'playing'; k++) {
        sim.step();
        for (const e of sim.snapshot().events) if (e.e === 'reset') resets++;
        if (process.env.TRACE && k % Number(process.env.EVERY ?? 180) === 0) {
          const c = sim.cargoPos();
          const sec = course.sections.find((q) => c.x >= q.x0 && c.x < q.x1)!;
          const L = (x: number) => { const q = course.sections.find((z) => x >= z.x0 && x < z.x1); return q ? `${q.name.slice(0, 3)}${(x - q.x0).toFixed(1)}` : x.toFixed(1); };
          console.log(`  t=${sim.time.toFixed(0)} cargo=${L(c.x)},${c.y.toFixed(1)} held=${sim.holders()} r${sim.route.i}/${sim.route.dir} pad${sim.padLoad.filter((x) => x > 0).map((x) => x.toFixed(2))} ` + sim.players.map((p) => { const t = p.body.translation(); return `${L(t.x)},${t.y.toFixed(1)}${p.grab ? p.grab.kind[0] : ''}:${p.brain.mode}${p.grounded ? '' : '^'}`; }).join(' '));
        }
      }
      const cx = sim.cargoPos().x;
      const sec = course.sections.find((q) => cx >= q.x0 && cx < q.x1);
      row.push(sim.status === 'delivered' ? `d${d}: OK ${sim.time.toFixed(0)}s dmg${sim.damage.toFixed(0)} r${resets}` : `d${d}: STUCK @${sec?.name}+${sec ? (cx - sec.x0).toFixed(1) : '?'} r${resets}`);
      sim.free();
    }
    console.log(piece.padEnd(10), row.join(' | '));
  }
}
