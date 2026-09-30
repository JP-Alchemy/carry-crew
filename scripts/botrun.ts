import { initPhysics, Sim } from '../src/shared/sim';
import { buildCourse, allCampaignSpecs, dailySpec, weeklySpec } from '../src/shared/courses';
import type { CourseSpec } from '../src/shared/types';

await initPhysics();
const arg = process.argv[2];
const crew = Number(process.argv[3] ?? 3);
const maxMin = Number(process.argv[4] ?? 8);
let specs: CourseSpec[] = allCampaignSpecs();
if (arg === 'daily') specs = [dailySpec()];
else if (arg === 'weekly') specs = [weeklySpec()];
else if (arg && arg !== 'all') specs = specs.filter((s) => `${s.biome}-${s.index + 1}` === arg);
for (const spec of specs) {
  const course = buildCourse(spec);
  const sim = new Sim(course, { crew: Array.from({ length: crew }, () => ({ bot: true })) });
  let resets = 0, drops = 0;
  const cpTimes: number[] = [];
  const t0 = performance.now();
  const steps = maxMin * 60 * 60;
  let lastCpT = 0;
  for (let k = 0; k < steps && sim.status === 'playing'; k++) {
    sim.step();
    for (const e of sim.snapshot().events) {
      if (e.e === 'reset') { resets++; if (e.reason === 'drop') drops++; }
      if (e.e === 'checkpoint') { cpTimes.push(Math.round(sim.time)); lastCpT = sim.time; }
    }
    if (process.env.TRACE && k % Number(process.env.EVERY ?? 300) === 0 && sim.time >= Number(process.env.FROM ?? 0)) {
      const c = sim.cargoPos();
      const L = (x: number) => { const q = course.sections.find((z) => x >= z.x0 && x < z.x1); return q ? `${q.name.slice(0, 4)}${(x - q.x0).toFixed(1)}` : x.toFixed(1); };
      console.log(`  t=${sim.time.toFixed(0)} cp=${sim.cp} r${sim.route.i}/${sim.route.dir} cargo=(${L(c.x)},${c.y.toFixed(1)}) held=${sim.holders()} dmg=${sim.damage.toFixed(0)} players=${sim.players.map(p=>{const t=p.body.translation();return `${L(t.x)},${t.y.toFixed(1)}${p.grab?p.grab.kind[0]:''}:${p.brain.mode}${p.grounded?'':'^'}`}).join(' ')}`);
    }
    if (sim.time - lastCpT > 150) break;
  }
  const ms = performance.now() - t0;
  const cx = sim.cargoPos().x;
  const sec = course.sections.find((q) => cx >= q.x0 && cx < q.x1);
  console.log(`${course.id.padEnd(12)} @${sec?.name}+${sec ? (cx - sec.x0).toFixed(1) : '?'} ${course.name.padEnd(28)} ${sim.status.padEnd(9)} cp ${sim.cp}/${course.checkpoints.length - 1} time ${sim.time.toFixed(0)}s par ${course.parTime} dmg ${sim.damage.toFixed(0)} resets ${resets} (drops ${drops}) stars ${sim.starsFor()} cps@${cpTimes.join(',')} [${(ms / (sim.t * 1000 / 1000)).toFixed(2)}ms/simsec]`);
  sim.free();
}
