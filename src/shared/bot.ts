import RAPIER from '@dimforge/rapier2d-compat';
import * as C from './constants';
import type { Sim } from './sim';
import type { PingKind, PlayerInput } from './types';

// Bot crewmates: simple "follow and grab" helpers. A crew plan assigns two carriers (one per side of
// the cargo, adjacent on the rope so nobody gets trapped under the cake); everyone else walks ahead
// of or behind the carriers in rope order. Bots wait out hazards, jump at course hints and obstacles,
// and panic-grab when falling.

export interface BotBrain {
  jumpN: number;
  diveN: number;
  jumpCd: number;
  stuckT: number;
  lastX: number;
  ping?: { kind: PingKind; x: number; y: number; t: number };
  climbT: number;
  seenHumanJump: number;
  slot: number; // -1 left carrier, 1 right carrier, 0 none
  blockT: number;
  lowT: number;
  mode: string; // for debugging
}

export function newBotBrain(i: number): BotBrain {
  return { jumpN: 0, diveN: 0, jumpCd: 0.3 + i * 0.05, stuckT: 0, lastX: 0, climbT: 0, seenHumanJump: 0, slot: 0, mode: '', blockT: 0, lowT: 0 };
}

const SOLID_GROUPS = C.groups(C.G_PLAYER, C.G_TERRAIN | C.G_PROP);

function rayHit(sim: Sim, x: number, y: number, dx: number, dy: number, len: number, exclude: RAPIER.Collider): number {
  const hit = sim.world.castRay(new RAPIER.Ray({ x, y }, { x: dx, y: dy }), len, true, undefined, SOLID_GROUPS, exclude, undefined, (col) => {
    const inf = sim.info.get(col.handle);
    return !!inf && (inf.kind === 'terrain' || inf.kind === 'prop' || inf.kind === 'mover') && !(inf.kind === 'terrain' && sim.course.solids[inf.solid!]?.tag === 'invisible');
  });
  return hit ? hit.timeOfImpact : -1;
}

/** Decide who carries: the bots nearest the cargo, one per side. */
export function planCrew(sim: Sim) {
  const ps = sim.players;
  const ct = sim.cargoPos();
  const want = Math.min(ps.length, 2);
  const holding = ps.map((p) => p.grab?.kind === 'cargo');
  const sideOf = (k: number) => Math.sign(ps[k].body.translation().x - ct.x) || 1;
  const sides = new Set<number>();
  ps.forEach((p, k) => {
    if (holding[k]) {
      p.brain.slot = sideOf(k);
      sides.add(p.brain.slot);
    } else if (!p.bot) p.brain.slot = 0;
  });
  // Drop assignments that clash with a side someone already holds.
  ps.forEach((p, k) => {
    if (p.bot && !holding[k] && p.brain.slot !== 0) {
      if (sides.has(p.brain.slot) || sides.size >= want) p.brain.slot = 0;
      else sides.add(p.brain.slot);
    }
  });
  while (sides.size < want) {
    const free = ps
      .map((p, k) => ({ p, k, d: Math.hypot(p.body.translation().x - ct.x, p.body.translation().y - ct.y) }))
      .filter((o) => o.p.bot && !holding[o.k] && o.p.brain.slot === 0)
      .sort((a, b) => a.d - b.d);
    if (!free.length) return;
    const o = free[0];
    let side = sideOf(o.k);
    if (sides.has(side)) side = -side;
    o.p.brain.slot = side;
    sides.add(side);
  }
}

/** Is it dangerous to walk the span [lo, hi] forward (dir) at `speed` over the next moments? */
function dangerAhead(sim: Sim, lo: number, hi: number, y: number, dir: number, speed: number): boolean {
  // Hazard zones: once we step into one we keep going, so decide before the first of a group
  // (e.g. a row of burners) whether the whole group can be crossed at walking pace.
  const zs = sim.course.zones.filter((z) => (z.kind === 'heat' || z.kind === 'water') && Math.abs(y - z.y) < z.h / 2 + 1.5);
  const inside = zs.some((z) => hi > z.x - z.w / 2 && lo < z.x + z.w / 2);
  if (!inside) {
    const ahead = zs
      .map((z) => ({ z, near: dir > 0 ? z.x - z.w / 2 - hi : lo - (z.x + z.w / 2) }))
      .filter((o) => o.near >= 0 && o.near < 7)
      .sort((a, b) => a.near - b.near);
    if (ahead.length && ahead[0].near < 1.3) {
      const far = Math.max(...ahead.map((o) => (dir > 0 ? o.z.x + o.z.w / 2 - lo : hi - (o.z.x - o.z.w / 2))));
      for (let tau = 0; tau <= far / speed + 0.3; tau += 0.1) {
        const l = lo + dir * speed * tau;
        const h = hi + dir * speed * tau;
        for (const { z } of ahead) if (h > z.x - z.w / 2 && l < z.x + z.w / 2 && sim.zoneActive(z, sim.t + tau)) return true;
      }
    }
  }
  const lookT = 4.5;
  speed *= 0.8; // we rarely keep full pace: plan for a slower crossing
  for (const m of sim.movers) {
    if (!m.def.knock || m.def.botIgnore) continue;
    const path = m.def.path;
    const reach =
      path.type === 'line'
        ? [Math.min(path.ax, path.bx) - m.def.w / 2, Math.max(path.ax, path.bx) + m.def.w / 2]
        : path.type === 'pendulum'
          ? [path.px - path.len * Math.sin(path.amp) - m.def.w / 2, path.px + path.len * Math.sin(path.amp) + m.def.w / 2]
          : [-Infinity, Infinity];
    if ((dir > 0 ? reach[0] - hi : lo - reach[1]) > 1.3) continue;
    const passT = dir > 0 ? (reach[1] - lo) / speed : (hi - reach[0]) / speed;
    if (passT < 0) continue;
    const overlaps = (pose: { x: number; y: number }, l: number, h: number) =>
      h + 0.3 > pose.x - m.def.w / 2 && l - 0.3 < pose.x + m.def.w / 2 && !(pose.y - m.def.h / 2 > y + 1.0 || pose.y + m.def.h / 2 < y - 0.3);
    if (overlaps(sim.moverPose(m.def, sim.t), lo, hi)) continue; // already in it: move on
    for (let tau = 0; tau <= Math.min(lookT, passT + 0.2); tau += 0.1) {
      if (overlaps(sim.moverPose(m.def, sim.t + tau), lo + dir * speed * tau, hi + dir * speed * tau)) return true;
    }
  }
  return false;
}

export function botInput(sim: Sim, i: number, dt: number): PlayerInput {
  const p = sim.players[i];
  const br = p.brain;
  const inp: PlayerInput = { mx: 0, up: false, down: false, grab: false, jumpN: br.jumpN, diveN: br.diveN };
  br.jumpCd = Math.max(0, br.jumpCd - dt);
  const jump = () => {
    if (br.jumpCd > 0) return;
    br.jumpN++;
    inp.jumpN = br.jumpN;
    br.jumpCd = 0.45;
  };

  const pos = p.body.translation();
  const vel = p.body.linvel();
  const main = sim.cargo[0];
  const ct = main.body.translation();
  const cw = main.w;
  const goal = sim.course.goal;
  const edge = cw / 2 + C.PLAYER_R;

  if (sim.status === 'delivered') {
    if (p.grounded && Math.random() < 0.02) jump();
    return inp;
  }

  // Panic: falling fast → grab anything.
  if (!p.grounded && vel.y < -5 && !p.grab) {
    inp.grab = true;
    return inp;
  }

  // Hanging from rope / ledge / prop: climb up, then let go toward the crew.
  if (p.grab && p.grab.kind !== 'cargo') {
    br.mode = 'hang-' + p.grab.kind;
    inp.grab = true;
    br.climbT += dt;
    if (p.grab.kind === 'ledge') {
      inp.up = br.climbT > 0.2;
      inp.mx = p.facing;
      return inp;
    }
    else if (p.grab.kind === 'rope') {
      inp.up = true;
      if (br.climbT > 2.5 || p.stamina < 1) {
        br.climbT = 0;
        jump();
      }
    } else if (br.climbT > 0.6) jump();
    inp.mx = Math.sign(ct.x - pos.x) * 0.5;
    return inp;
  }
  br.climbT = 0;

  const humanHolder = sim.players.find((q) => !q.bot && q.grab?.kind === 'cargo');
  const n = sim.players.length;
  const want = Math.min(n, 2);
  const holders = sim.holders();
  const dir = Math.sign(goal.x - ct.x) || 1;
  const nearGoal = Math.abs(goal.x - ct.x) < 0.35;

  const ping = br.ping && sim.t - br.ping.t < 3.5 ? br.ping : undefined;
  if (ping?.kind === 'jump' && sim.t - ping.t < 0.25) jump();
  const pingWait = ping?.kind === 'wait';

  // ---------------------------------------------------------------- carrying
  if (p.grab?.kind === 'cargo') {
    br.mode = 'carry';
    inp.grab = true;
    let mx: number;
    if (humanHolder) {
      mx = humanHolder.input.mx;
      if (humanHolder.lastJumpN !== br.seenHumanJump) {
        br.seenHumanJump = humanHolder.lastJumpN;
        br.jumpCd = 0;
        jump();
      }
    } else {
      mx = nearGoal ? 0 : dir;
      if (holders < want) mx = 0; // wait for the other carrier
      const lo = Math.min(ct.x - cw / 2, pos.x) - 0.5;
      const hi = Math.max(ct.x + cw / 2, pos.x) + 0.5;
      if (mx !== 0 && dangerAhead(sim, lo, hi, pos.y, dir, C.CARRY_SPEED)) mx = 0;
      if (pingWait) mx = 0;
      // Jump at hints, keyed on the cargo's front so both carriers jump together.
      const lead = (dir > 0 ? ct.x + cw / 2 + C.PLAYER_R * 2 : ct.x - cw / 2 - C.PLAYER_R * 2) + dir * 0.2;
      for (const h of sim.course.hints) {
        if (mx === 0) break;
        if (h.a === 'jump') {
          const d = (h.x - lead) * dir;
          if (d > -0.15 && d < 0.3) {
            jump();
            break;
          }
        } else if (h.a === 'gap') {
          const d = (h.x - pos.x) * dir;
          if (d > -0.05 && d < 0.35 && (p.grounded || p.restT > 0.2)) {
            br.jumpCd = 0;
            jump();
            break;
          }
        }
      }
      // Cargo snagged on something? Everyone hops together.
      if (mx !== 0 && Math.abs(main.body.linvel().x) < 0.35) br.blockT += dt;
      else br.blockT = Math.max(0, br.blockT - dt);
      // The front carrier steps up first; the back one follows a moment later.
      const front = Math.sign(pos.x - ct.x) === dir;
      if (br.blockT > (front ? 0.3 : 0.6) && (p.grounded || p.restT > 0.2)) {
        br.jumpCd = 0;
        jump();
        br.blockT = -0.3;
      }
      if (mx !== 0 && p.grounded && Math.sign(pos.x - ct.x) === dir) {
        const wall = rayHit(sim, pos.x, pos.y - C.PLAYER_R * 0.4, dir, 0, C.PLAYER_R + 0.35, p.collider);
        if (wall >= 0) jump();
      }
    }
    // Fell well below the cargo (into a gap or a lane)? Let go and climb back up.
    br.lowT = ct.y - pos.y > 1.05 ? br.lowT + dt : 0;
    if (br.lowT > 1) {
      inp.grab = false;
      br.lowT = 0;
      return inp;
    }
    // Cargo hanging off a ledge below us: pull it back up.
    if (ct.y < pos.y - 1.2 && p.grounded) mx = -Math.sign(ct.x - pos.x);
    inp.mx = mx;
    stuckCheck(sim, i, inp, mx, jump, dt);
    return inp;
  }

  // ---------------------------------------------------------------- stuck in a pit below the crew?
  br.lowT = p.grounded && ct.y - pos.y > 1.0 && Math.abs(pos.x - ct.x) < 5 ? br.lowT + dt : Math.max(0, br.lowT - dt);
  if (br.lowT > 1.5) {
    // Climb our own rope up to the crew.
    br.mode = 'pit';
    inp.grab = true;
    inp.up = true;
    if (br.lowT > 4) br.lowT = 0;
    return inp;
  }

  // ---------------------------------------------------------------- fetch the cargo
  if ((br.slot !== 0 || ping?.kind === 'grab') && !(ping && ping.kind === 'go')) {
    const side = br.slot || Math.sign(pos.x - ct.x) || -1;
    br.mode = 'fetch';
    if (p.onCargo) {
      inp.mx = side; // step off
      return inp;
    }
    const tx = ct.x + side * (edge + 0.05);
    const dx = tx - pos.x;
    const dy = ct.y - pos.y;
    if (Math.abs(dx) < 0.3 && Math.abs(dy) < 1.1) {
      inp.grab = true;
      inp.mx = -side * 0.25; // face the cargo
      return inp;
    }
    inp.mx = Math.max(-1, Math.min(1, dx * 1.5));
    if (Math.abs(dx) < 1 && dy > 0.8) jump();
    navigate(sim, i, inp, jump, pos, Math.sign(dx), Math.abs(dx) > 2);
    stuckCheck(sim, i, inp, inp.mx, jump, dt);
    return inp;
  }

  // ---------------------------------------------------------------- follow in rope order
  br.mode = 'follow';
  let tx: number;
  const carriers = sim.players.map((q, k) => (q.grab?.kind === 'cargo' || q.brain.slot !== 0 ? k : -1)).filter((k) => k >= 0);
  if (ping && (ping.kind === 'go' || ping.kind === 'help')) {
    tx = ping.x;
  } else if (carriers.length) {
    const lo = Math.min(...carriers);
    const hi = Math.max(...carriers);
    if (i < lo) tx = ct.x - edge - 1.3 - (lo - i - 1) * 1.1;
    else if (i > hi) tx = ct.x + edge + 1.3 + (i - hi - 1) * 1.1;
    else tx = ct.x + (i - (lo + hi) / 2) * 0.5;
  } else {
    tx = ct.x - dir * (edge + 1.3 + i * 1.0);
  }
  // Keep the rope slack: never anchor a crewmate who is trying to move on.
  const ropeLen = sim.ropeLength;
  for (const k of [i - 1, i + 1]) {
    const q = sim.players[k];
    if (!q) continue;
    const qx = q.body.translation().x;
    if (Math.abs(qx - pos.x) > ropeLen * 0.75) tx = qx - Math.sign(qx - pos.x) * ropeLen * 0.5;
  }
  const dx = tx - pos.x;
  let mx = Math.abs(dx) < 0.4 ? 0 : Math.max(-1, Math.min(1, dx));
  if (pingWait) mx = 0;
  if (mx !== 0 && dangerAhead(sim, pos.x - 0.5, pos.x + 0.5, pos.y, Math.sign(mx), C.MOVE_SPEED)) mx = 0;
  inp.mx = mx;
  if (mx !== 0) navigate(sim, i, inp, jump, pos, Math.sign(mx), Math.abs(dx) > 2.2);
  // Dangling below the crew? Grab the rope and climb.
  if (!p.grounded && pos.y < ct.y - 2.2 && vel.y < 0.5) inp.grab = true;
  stuckCheck(sim, i, inp, mx, jump, dt);
  return inp;
}

function navigate(sim: Sim, i: number, inp: PlayerInput, jump: () => void, pos: { x: number; y: number }, dir: number, farTarget: boolean) {
  const p = sim.players[i];
  if (!p.grounded) return;
  for (const h of sim.course.hints) {
    if (h.a === 'wait') continue;
    const d = (h.x - pos.x) * dir;
    if (d > 0 && d < 0.55) {
      jump();
      return;
    }
  }
  const wall = rayHit(sim, pos.x, pos.y - C.PLAYER_R * 0.4, dir, 0, C.PLAYER_R + 0.3, p.collider);
  if (wall >= 0) {
    jump();
    return;
  }
  // A gap is only a gap if it's wider than we are.
  const ground = Math.max(...[0.55, 0.8, 1.05].map((o) => rayHit(sim, pos.x + dir * o, pos.y, 0, -1, 3, p.collider)));
  if (ground < 0) {
    if (farTarget) jump();
    else inp.mx = 0;
  }
}

function stuckCheck(sim: Sim, i: number, inp: PlayerInput, mx: number, jump: () => void, dt: number) {
  const p = sim.players[i];
  const br = p.brain;
  const x = p.body.translation().x;
  if (Math.abs(mx) > 0.3 && Math.abs(x - br.lastX) < 0.02) br.stuckT += dt;
  else br.stuckT = Math.max(0, br.stuckT - dt * 2);
  br.lastX = x;
  if (br.stuckT > 1.0) {
    if (p.grounded || p.restT > 0.2) jump();
    else if (p.grab?.kind !== 'cargo') {
      // Wedged against a wall in mid-air (the rope holds us)? Grab the edge and climb over.
      inp.grab = true;
      inp.ledge = true;
    }
    if (br.stuckT > 4) br.stuckT = 0;
  }
}
