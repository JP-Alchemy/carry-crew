// A scripted "human" (holds the cake, walks right, jumps at obstacles) with bot helpers.
import { initPhysics, Sim } from '../src/shared/sim';
import { buildCourse } from '../src/shared/courses';
import { emptyInput } from '../src/shared/types';
await initPhysics();
const course = buildCourse({ biome: 'kitchen', index: 0 });
const sim = new Sim(course, { crew: [{ bot: true }, { bot: false }, { bot: true }] });
let jumpN = 0;
let lastJump = 0;
for (let k = 0; k < 240 * 60 && sim.status === 'playing'; k++) {
  const me = sim.players[1];
  const pos = me.body.translation();
  const ct = sim.cargoPos();
  const inp = emptyInput();
  if (me.grab?.kind !== 'cargo') {
    const tx = ct.x - 1.1;
    inp.mx = Math.max(-1, Math.min(1, (tx - pos.x) * 2));
    inp.grab = Math.abs(tx - pos.x) < 0.4;
    if (Math.abs(me.body.linvel().x) < 0.3 && Math.abs(inp.mx) > 0.5 && sim.t - lastJump > 0.7) {
      jumpN++;
      lastJump = sim.t;
    }
  } else {
    inp.grab = true;
    inp.mx = 1;
    // jump at any jump hint ahead of the cake
    const front = ct.x + 1.2;
    if (course.hints.some((h) => h.a !== 'wait' && h.x - front > 0 && h.x - front < 0.4) && sim.t - lastJump > 0.6) {
      jumpN++;
      lastJump = sim.t;
    }
  }
  inp.jumpN = jumpN;
  sim.setInput(1, inp);
  sim.step();
  if (k % 300 === 0) console.log(sim.time.toFixed(0), "cargo", ct.x.toFixed(1), ct.y.toFixed(1), sim.players.map((p) => `${p.body.translation().x.toFixed(1)},${p.body.translation().y.toFixed(1)}${p.grab ? p.grab.kind[0] : ""}:${p.brain.mode}`).join(" "));
  for (const e of sim.snapshot().events) if (['checkpoint', 'reset', 'damage', 'slip'].includes(e.e)) console.log(sim.time.toFixed(1), JSON.stringify(e));
}
console.log(sim.status, 'time', sim.time.toFixed(0), 'damage', sim.damage.toFixed(0), 'stars', sim.starsFor());
