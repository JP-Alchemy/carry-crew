import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { BODY_COLORS, ROPES } from '../../shared/cosmetics';
import { PLAYER_R } from '../../shared/constants';
import type { CargoKind, Look, PlayerSnap } from '../../shared/types';
import { CONE, CYL, SPHERE, disposeTree, geo, mesh, toon, toonUnique } from './materials';

const R = PLAYER_R;

export function buildHat(id: string): THREE.Object3D {
  const g = new THREE.Group();
  switch (id) {
    case 'party': {
      const c = mesh(CONE(), toon(0xff5a7a), 0, 0.22, 0, 0.17, 0.44, 0.17);
      g.add(c);
      g.add(mesh(SPHERE(), toon(0xffd93b), 0, 0.46, 0, 0.06, 0.06, 0.06));
      g.add(mesh(geo('tor', () => new THREE.TorusGeometry(1, 0.2, 6, 16)), toon(0xffd93b), 0, 0.12, 0, 0.13, 0.13, 0.13).rotateX(Math.PI / 2));
      g.rotation.z = -0.15;
      break;
    }
    case 'chef':
      g.add(mesh(CYL(), toon(0xffffff), 0, 0.1, 0, 0.2, 0.2, 0.2));
      for (let k = 0; k < 4; k++) g.add(mesh(SPHERE(), toon(0xffffff), Math.cos(k * 1.6) * 0.1, 0.28, Math.sin(k * 1.6) * 0.1, 0.16, 0.14, 0.16));
      break;
    case 'beanie':
      g.add(mesh(SPHERE(), toon(0x4dc3ff), 0, 0.02, 0, 0.3, 0.22, 0.3));
      g.add(mesh(CYL(), toon(0x2b8fcf), 0, 0.0, 0, 0.3, 0.08, 0.3));
      g.add(mesh(SPHERE(), toon(0xffffff), 0, 0.25, 0, 0.08, 0.08, 0.08));
      break;
    case 'propeller': {
      g.add(mesh(SPHERE(), toon(0xff5a5a), 0, 0.0, 0, 0.27, 0.16, 0.27));
      g.add(mesh(CYL(), toon(0x333333), 0, 0.18, 0, 0.02, 0.14, 0.02));
      const p = new THREE.Group();
      p.name = 'spin';
      p.position.y = 0.25;
      p.add(mesh(SPHERE(), toon(0xffd93b), 0.17, 0, 0, 0.17, 0.02, 0.05));
      p.add(mesh(SPHERE(), toon(0x4dc3ff), -0.17, 0, 0, 0.17, 0.02, 0.05));
      g.add(p);
      break;
    }
    case 'bucket':
      g.add(mesh(CYL(), toon(0xff5a5a), 0, 0.12, 0, 0.24, 0.3, 0.24));
      g.rotation.z = 0.3;
      break;
    case 'crown':
      g.add(mesh(CYL(), toon(0xffd23b), 0, 0.06, 0, 0.2, 0.14, 0.2));
      for (let k = 0; k < 5; k++) {
        const a = (k / 5) * Math.PI * 2;
        g.add(mesh(CONE(), toon(0xffd23b), Math.cos(a) * 0.17, 0.2, Math.sin(a) * 0.17, 0.05, 0.14, 0.05));
      }
      break;
    case 'cone':
      g.add(mesh(CONE(), toon(0xff7a1a), 0, 0.25, 0, 0.22, 0.5, 0.22));
      g.add(mesh(CYL(), toon(0xffffff), 0, 0.2, 0, 0.14, 0.07, 0.14));
      break;
    case 'frog':
      g.add(mesh(SPHERE(), toon(0x6cc24a), 0, 0.02, 0, 0.3, 0.2, 0.3));
      g.add(mesh(SPHERE(), toon(0xffffff), -0.12, 0.17, 0.14, 0.08, 0.08, 0.08));
      g.add(mesh(SPHERE(), toon(0xffffff), 0.12, 0.17, 0.14, 0.08, 0.08, 0.08));
      g.add(mesh(SPHERE(), toon(0x111111), -0.12, 0.17, 0.2, 0.04, 0.04, 0.04));
      g.add(mesh(SPHERE(), toon(0x111111), 0.12, 0.17, 0.2, 0.04, 0.04, 0.04));
      break;
    case 'halo': {
      const h = mesh(geo('tor', () => new THREE.TorusGeometry(1, 0.2, 6, 16)), toonUnique(0xffe066, { emissive: 0x886600 }), 0, 0.2, 0, 0.2, 0.2, 0.2);
      h.rotation.x = Math.PI / 2;
      g.add(h);
      break;
    }
    default:
      break;
  }
  return g;
}

function bodyGeometry(shape: number) {
  switch (shape) {
    case 1:
      return geo('body1', () => new THREE.SphereGeometry(R, 18, 14));
    case 2:
      return geo('body2', () => new RoundedBoxGeometry(R * 1.75, R * 1.75, R * 1.6, 3, 0.12));
    case 3:
      return geo('body3', () => new THREE.CapsuleGeometry(R * 0.72, R * 0.9, 6, 14));
    default:
      return geo('body0', () => new THREE.CapsuleGeometry(R * 0.85, R * 0.45, 6, 14));
  }
}

/**
 * A two-segment floppy limb (upper + lower, e.g. shoulder → elbow → hand), simulated with verlet
 * in world space. It trails, swings and flails on its own; a gripping hand is pinned in place.
 */
class Limb {
  readonly pts = [new THREE.Vector2(), new THREE.Vector2()];
  private prev = [new THREE.Vector2(), new THREE.Vector2()];
  private ready = false;
  constructor(
    readonly l1: number,
    readonly l2: number,
  ) {}

  reset(anchor: THREE.Vector2, dir: THREE.Vector2) {
    this.pts[0].copy(anchor).addScaledVector(dir, this.l1);
    this.pts[1].copy(this.pts[0]).addScaledVector(dir, this.l2);
    this.prev[0].copy(this.pts[0]);
    this.prev[1].copy(this.pts[1]);
    this.ready = true;
  }

  update(dt: number, anchor: THREE.Vector2, opts: { gravity: number; pin?: THREE.Vector2; pull?: THREE.Vector2; pullK?: number; kick?: THREE.Vector2 }) {
    if (!this.ready || this.pts[1].distanceTo(anchor) > 4) this.reset(anchor, new THREE.Vector2(0, -1));
    const h = Math.min(dt, 1 / 30);
    for (let k = 0; k < 2; k++) {
      const p = this.pts[k];
      const v = p.clone().sub(this.prev[k]).multiplyScalar(0.9);
      this.prev[k].copy(p);
      v.y -= opts.gravity * h * h;
      if (k === 1 && opts.pull) v.addScaledVector(opts.pull.clone().sub(p), (opts.pullK ?? 0.2) * Math.min(1, h * 60));
      if (k === 1 && opts.kick) v.addScaledVector(opts.kick, h);
      p.add(v);
    }
    if (opts.pin) this.pts[1].copy(opts.pin);
    for (let it = 0; it < 4; it++) {
      // anchor ↔ joint
      const d0 = this.pts[0].clone().sub(anchor);
      const len0 = d0.length() || 1e-4;
      this.pts[0].copy(anchor).addScaledVector(d0, this.l1 / len0);
      // joint ↔ end (a pinned hand may stretch the arm a little: rubbery toys)
      const d1 = this.pts[1].clone().sub(this.pts[0]);
      const len1 = d1.length() || 1e-4;
      const target = opts.pin ? Math.min(len1, this.l2 * 2.2) : this.l2;
      const corr = d1.multiplyScalar((len1 - target) / len1);
      if (opts.pin) this.pts[0].add(corr);
      else {
        this.pts[0].addScaledVector(corr, 0.3);
        this.pts[1].addScaledVector(corr, -0.7);
      }
    }
  }
}

function segment(m: THREE.Object3D, a: THREE.Vector2, b: THREE.Vector2, ox: number, oy: number, z: number) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  m.position.set(a.x - ox, a.y - oy, z);
  m.scale.set(1, Math.max(0.02, Math.hypot(dx, dy)), 1);
  m.rotation.set(0, 0, Math.atan2(-dx, dy));
}

export class CharacterView {
  readonly group = new THREE.Group();
  private tilt = new THREE.Group();
  private face = new THREE.Group();
  private body!: THREE.Mesh;
  private hat!: THREE.Object3D;
  private hatSpin?: THREE.Object3D;
  private eyes = new THREE.Group();
  private pupils: THREE.Mesh[] = [];
  private limbMeshes: THREE.Object3D[] = [];
  private arms = [new Limb(0.19, 0.2), new Limb(0.19, 0.2)];
  private legs = [new Limb(0.15, 0.16), new Limb(0.15, 0.16)];
  private phase = Math.random() * 10;
  private squash = 0;
  private lastVy = 0;
  private lastVx = 0;
  private blink = 0;
  private emoteT = 0;
  private emote = '';
  private z = 0;
  private dizzy?: THREE.Group;
  // jelly wobble (a spring on the body driven by acceleration)
  private wob = new THREE.Vector2();
  private wobV = new THREE.Vector2();
  look: Look;
  /** Small depth offset per crew member so overlapping players don't z-fight. */
  lane = 0;

  constructor(look: Look) {
    this.look = look;
    this.group.add(this.tilt);
    this.build();
  }

  private build() {
    disposeTree(this.tilt);
    this.limbMeshes.forEach((m) => {
      disposeTree(m);
      this.group.remove(m);
    });
    this.tilt.clear();
    this.face = new THREE.Group();
    const col = BODY_COLORS[this.look.body] ?? BODY_COLORS[0];
    this.body = new THREE.Mesh(bodyGeometry(this.look.shape), toon(col));
    this.body.castShadow = true;
    if (this.look.shape === 3) this.body.position.y = 0.1;
    this.tilt.add(this.body, this.face);
    // Face
    this.eyes = new THREE.Group();
    this.pupils = [];
    for (const x of [-0.12, 0.12]) {
      const white = mesh(SPHERE(), toon(0xffffff), x, 0.08, R * 0.8, 0.11, 0.13, 0.07);
      const pupil = mesh(SPHERE(), toon(0x1b1b1b), x, 0.07, R * 0.88, 0.065, 0.08, 0.04);
      this.eyes.add(white, pupil);
      this.pupils.push(pupil);
    }
    this.eyes.add(mesh(SPHERE(), toon(0xff8f8f, { opacity: 0.6 }), -0.2, -0.04, R * 0.78, 0.06, 0.04, 0.02));
    this.eyes.add(mesh(SPHERE(), toon(0xff8f8f, { opacity: 0.6 }), 0.2, -0.04, R * 0.78, 0.06, 0.04, 0.02));
    if (this.look.shape === 3) this.eyes.position.y = 0.18;
    this.face.add(this.eyes);
    this.hat = buildHat(this.look.hat);
    this.hat.position.y = this.look.shape === 3 ? R + 0.3 : this.look.shape === 2 ? R * 0.88 : R + 0.02;
    this.hatSpin = this.hat.getObjectByName('spin') ?? undefined;
    this.face.add(this.hat);
    // Dizzy stars (shown while knocked silly)
    this.dizzy = new THREE.Group();
    for (let k = 0; k < 3; k++) {
      const st = mesh(SPHERE(), toonUnique(0xffe066, { emissive: 0x886600 }), Math.cos((k * Math.PI * 2) / 3) * 0.3, 0, Math.sin((k * Math.PI * 2) / 3) * 0.3, 0.06, 0.06, 0.06);
      this.dizzy.add(st);
    }
    this.dizzy.position.y = R + 0.35;
    this.dizzy.visible = false;
    this.tilt.add(this.dizzy);
    // Limbs: upper + lower cylinders and a hand/foot, placed from the verlet points every frame.
    const segGeo = geo('limbseg', () => new THREE.CylinderGeometry(0.045, 0.04, 1, 6).translate(0, 0.5, 0));
    const legGeo = geo('legseg', () => new THREE.CylinderGeometry(0.05, 0.045, 1, 6).translate(0, 0.5, 0));
    const handGeo = geo('handball', () => new THREE.SphereGeometry(0.075, 8, 6));
    const footGeo = geo('football', () => new THREE.SphereGeometry(1, 8, 6));
    this.limbMeshes = [];
    for (let k = 0; k < 2; k++) {
      const up = new THREE.Mesh(segGeo, toon(col));
      const lo = new THREE.Mesh(segGeo, toon(col));
      const hand = new THREE.Mesh(handGeo, toon(0xffffff));
      this.limbMeshes.push(up, lo, hand);
    }
    for (let k = 0; k < 2; k++) {
      const up = new THREE.Mesh(legGeo, toon(0x3b3b3b));
      const lo = new THREE.Mesh(legGeo, toon(0x3b3b3b));
      const foot = new THREE.Mesh(footGeo, toon(0x2b2b2b));
      foot.scale.set(0.1, 0.07, 0.13);
      this.limbMeshes.push(up, lo, foot);
    }
    this.limbMeshes.forEach((m) => {
      m.castShadow = true;
      this.group.add(m);
    });
  }

  setLook(look: Look) {
    if (JSON.stringify(look) === JSON.stringify(this.look)) return;
    this.look = look;
    this.build();
  }

  playEmote(kind: string) {
    this.emote = kind;
    this.emoteT = 1.2;
  }

  update(s: PlayerSnap, dt: number, t: number, cargoX?: number) {
    // Players pass through the cargo and each other: step toward the camera when overlapping.
    const front = s.c || (cargoX !== undefined && Math.abs(s.x - cargoX) < 1.1);
    this.z += ((front ? 0.6 : this.lane) - this.z) * Math.min(1, dt * 10);
    this.group.position.set(s.x, s.y, this.z);
    const h = Math.max(1e-3, dt);
    const speed = Math.abs(s.vx);
    this.phase += dt * (s.g ? speed * 3.2 : 1.5);
    const ax = (s.vx - this.lastVx) / h;
    const ay = (s.vy - this.lastVy) / h;
    // squash on landing
    if (s.g && this.lastVy < -6) this.squash = Math.min(0.4, -this.lastVy * 0.035);
    this.lastVx = s.vx;
    this.lastVy = s.vy;
    this.squash *= Math.pow(0.001, dt);
    // jelly wobble: sloshes against sudden acceleration (yanks, landings, launches)
    const acc = new THREE.Vector2(Math.max(-80, Math.min(80, ax)), Math.max(-80, Math.min(80, ay)));
    this.wobV.addScaledVector(this.wob, -180 * dt).addScaledVector(this.wobV, -7 * dt).addScaledVector(acc, -0.004);
    this.wob.addScaledVector(this.wobV, dt);
    this.wob.clampLength(0, 0.35);
    const stretch = s.g ? 0 : Math.max(-0.12, Math.min(0.2, s.vy * 0.02));
    const bob = s.g ? Math.abs(Math.sin(this.phase)) * Math.min(1, speed / 3) * 0.05 : 0;
    const sq = this.squash + this.wob.y * 0.6;
    this.tilt.scale.set(1 + sq * 0.6 - stretch * 0.4 + Math.abs(this.wob.x) * 0.3, 1 - sq + stretch, 1 + sq * 0.6 - stretch * 0.4);
    this.tilt.position.y = bob - this.squash * R * 0.5;
    // Tumble (from the sim), lean into running, wobble
    let rot = (s.a ?? 0) - s.vx * 0.045 + this.wob.x * 1.2;
    if (s.s === 1) rot = (s.a ?? 0) - s.f * 0.3;
    else if (s.s === 3) rot = Math.sin(t * 3) * 0.1;
    this.tilt.rotation.z = rot;
    // The face (eyes + hat) lags behind the body like a bobble head.
    this.face.position.set(this.wob.x * 0.4, this.wob.y * 0.25, 0);
    const yaw = s.f * 0.55;
    this.face.rotation.y += (yaw - this.face.rotation.y) * Math.min(1, dt * 10);
    this.body.rotation.y = this.face.rotation.y;
    // emotes
    if (this.emoteT > 0) {
      this.emoteT -= dt;
      if (this.emote === 'facepalm') this.face.rotation.x = 0.4;
      else if (this.emote === 'cheer') this.tilt.position.y += Math.abs(Math.sin(this.emoteT * 12)) * 0.15;
    } else this.face.rotation.x *= 0.9;
    // eyes: blink; big scared eyes when flying or knocked silly; spiral when dizzy
    this.blink -= dt;
    if (this.blink < -3 - Math.random() * 3) this.blink = 0.12;
    const scared = s.s === 2 || s.vy < -8 || s.vy > 9;
    const eyeScale = this.blink > 0 ? 0.15 : scared ? 1.6 : 1;
    this.pupils.forEach((p, k) => {
      p.scale.y = 0.08 * eyeScale;
      p.scale.x = 0.065 * (scared ? 1.25 : 1);
      p.position.x = (k ? 0.12 : -0.12) + (s.s === 2 ? Math.cos(t * 14 + k * Math.PI) * 0.03 : Math.max(-0.03, Math.min(0.03, s.vx * 0.01)));
      p.position.y = 0.07 + (s.s === 2 ? Math.sin(t * 14 + k * Math.PI) * 0.03 : Math.max(-0.03, Math.min(0.03, s.vy * 0.005)));
    });
    if (this.dizzy) {
      this.dizzy.visible = s.s === 2;
      this.dizzy.rotation.y = t * 6;
    }
    // ---- limbs (world space) ----
    const cos = Math.cos(rot);
    const sin = Math.sin(rot);
    const w = (lx: number, ly: number) => new THREE.Vector2(s.x + lx * cos - ly * sin, s.y + lx * sin + ly * cos + this.tilt.position.y);
    const gravity = 22;
    const holding = s.hx !== undefined && s.hy !== undefined;
    const airborne = !s.g;
    for (let k = 0; k < 2; k++) {
      const side = k === 0 ? s.f : -s.f;
      const anchor = w(side * R * 0.78, 0.03);
      let pin: THREE.Vector2 | undefined;
      let pull: THREE.Vector2 | undefined;
      let pullK = 0.12;
      let kick: THREE.Vector2 | undefined;
      if (holding && (k === 0 || s.c || s.s === 3)) {
        // Both hands on the cargo / hanging; the front hand only on a ledge or the rope.
        const off = k === 0 || !s.c ? 0 : -side * 0.18;
        pin = new THREE.Vector2(s.hx! + off, s.hy! + (k === 0 ? 0 : 0.05));
        if (k === 1 && !s.c) pin.addScaledVector(new THREE.Vector2(side * 0.06, -0.05), 1);
      } else if (this.emoteT > 0 && (this.emote === 'cheer' || this.emote === 'highfive')) {
        pull = w(side * 0.3, 0.75);
        pullK = 0.4;
      } else if (this.emoteT > 0 && this.emote === 'blame' && k === 0) {
        pull = w(side * 0.8, 0.15);
        pullK = 0.4;
      } else if (airborne) {
        // Flail!
        pull = w(side * 0.45, 0.35 + Math.sin(t * 22 + k * 2) * 0.25);
        pullK = 0.08;
        kick = new THREE.Vector2(Math.sin(t * 31 + k) * 6, Math.cos(t * 27 + k * 3) * 6);
      } else {
        const sw = Math.sin(this.phase + k * Math.PI) * Math.min(1, speed / 3);
        pull = w(side * 0.22 + sw * 0.28 * s.f, -0.28);
        pullK = 0.06;
      }
      this.arms[k].update(dt, anchor, { gravity, pin, pull, pullK, kick });
    }
    for (let k = 0; k < 2; k++) {
      const side = k === 0 ? -1 : 1;
      const hip = w(side * 0.12, -R * 0.55);
      let pull: THREE.Vector2;
      let pullK = 0.35;
      let kick: THREE.Vector2 | undefined;
      if (!airborne) {
        // Walk cycle: feet step under the hips.
        const ph = this.phase + k * Math.PI;
        const stride = Math.min(1, speed / 3);
        pull = new THREE.Vector2(s.x + side * 0.1 + Math.cos(ph) * 0.2 * stride * s.f, s.y - R - 0.05 + Math.max(0, Math.sin(ph)) * 0.14 * stride);
      } else {
        pull = w(side * 0.2, -R - 0.25);
        pullK = 0.05;
        kick = new THREE.Vector2(Math.cos(t * 25 + k * 2) * 5, Math.sin(t * 21 + k) * 4);
      }
      this.legs[k].update(dt, hip, { gravity, pull, pullK, kick });
    }
    // Place the meshes
    const ox = s.x;
    const oy = s.y;
    const limbs = [...this.arms.map((l, k) => ({ l, anchor: w((k === 0 ? s.f : -s.f) * R * 0.78, 0.03), z: 0.08 * (k === 0 ? 1 : -1) })), ...this.legs.map((l, k) => ({ l, anchor: w((k === 0 ? -1 : 1) * 0.12, -R * 0.55), z: 0.08 * (k === 0 ? 1 : -1) }))];
    limbs.forEach(({ l, anchor, z }, k) => {
      const [up, lo, end] = this.limbMeshes.slice(k * 3, k * 3 + 3);
      segment(up, anchor, l.pts[0], ox, oy, z);
      segment(lo, l.pts[0], l.pts[1], ox, oy, z);
      end.position.set(l.pts[1].x - ox, l.pts[1].y - oy, z);
      if (k >= 2) end.rotation.z = Math.atan2(l.pts[1].y - l.pts[0].y, l.pts[1].x - l.pts[0].x) + Math.PI / 2;
    });
    if (this.hatSpin) this.hatSpin.rotation.y = t * (s.g ? 6 : 25);
  }
}

// ------------------------------------------------------------------ cargo

export class CargoView {
  readonly group = new THREE.Group();
  private parts: THREE.Object3D[] = [];
  private layers: THREE.Object3D[] = [];
  private water?: THREE.Mesh;
  private fish?: THREE.Object3D;
  private cracks: THREE.Mesh[] = [];
  readonly kind: CargoKind;

  constructor(kind: CargoKind) {
    this.kind = kind;
    if (kind === 'cake') {
      const g = new THREE.Group();
      const colors = [0xf7c4d6, 0xfff1d6, 0xf7c4d6];
      for (let k = 0; k < 3; k++) {
        const r = 0.66 - k * 0.1;
        const l = new THREE.Group();
        l.add(mesh(CYL(), toon(0x9b5b3a), 0, 0, 0, r, 0.18, r));
        l.add(mesh(CYL(), toon(colors[k]), 0, 0.12, 0, r + 0.02, 0.08, r + 0.02));
        for (let j = 0; j < 7; j++) {
          const a = (j / 7) * Math.PI * 2;
          l.add(mesh(SPHERE(), toon(colors[k]), Math.cos(a) * (r + 0.01), 0.05, Math.sin(a) * (r + 0.01), 0.06, 0.1, 0.06));
        }
        l.position.y = -0.33 + k * 0.28;
        g.add(l);
        this.layers.push(l);
      }
      // candles + sprinkles on top
      const top = new THREE.Group();
      for (let j = 0; j < 3; j++) {
        top.add(mesh(CYL(), toon([0x4dc3ff, 0xffd93b, 0x7bd389][j]), (j - 1) * 0.16, 0.12, 0, 0.03, 0.22, 0.03));
        top.add(mesh(SPHERE(), toonUnique(0xffb13b, { emissive: 0xff7700 }), (j - 1) * 0.16, 0.27, 0, 0.035, 0.06, 0.035));
      }
      top.position.y = 0.26;
      this.layers[2].add(top);
      this.parts.push(g);
    } else if (kind === 'fishtank') {
      const g = new THREE.Group();
      g.add(mesh(new THREE.BoxGeometry(1.3, 0.95, 0.9), toon(0xbfeaff, { opacity: 0.35 })));
      // Chunky frame so the tank reads clearly against any background
      for (const x of [-0.64, 0.64]) g.add(mesh(new THREE.BoxGeometry(0.06, 0.97, 0.94), toon(0x2b6cb0), x, 0, 0));
      g.add(mesh(new THREE.BoxGeometry(1.34, 0.06, 0.94), toon(0x2b6cb0), 0, 0.46, 0));
      g.add(mesh(new THREE.BoxGeometry(1.32, 0.06, 0.92), toon(0x2b6cb0), 0, -0.45, 0));
      g.add(mesh(new THREE.BoxGeometry(1.24, 0.1, 0.84), toon(0xe6d3a3), 0, -0.38, 0));
      this.water = mesh(new THREE.BoxGeometry(1.22, 0.6, 0.82).translate(0, 0.3, 0), toonUnique(0x2f9bff, { opacity: 0.7 }), 0, -0.33, 0);
      g.add(this.water);
      const fish = new THREE.Group();
      fish.add(mesh(SPHERE(), toon(0xff8a1f), 0, 0, 0, 0.18, 0.12, 0.08));
      fish.add(mesh(CONE(), toon(0xff8a1f), -0.2, 0, 0, 0.08, 0.14, 0.03).rotateZ(Math.PI / 2));
      fish.add(mesh(SPHERE(), toon(0x111111), 0.1, 0.03, 0.06, 0.02, 0.02, 0.02));
      g.add(fish);
      this.fish = fish;
      this.parts.push(g);
    } else if (kind === 'vase') {
      const pts: THREE.Vector2[] = [];
      const prof = [0.18, 0.3, 0.34, 0.3, 0.2, 0.14, 0.16, 0.2];
      prof.forEach((r, k) => pts.push(new THREE.Vector2(r, -0.65 + (k / (prof.length - 1)) * 1.3)));
      const g = new THREE.Group();
      g.add(new THREE.Mesh(new THREE.LatheGeometry(pts, 18), toon(0xf4f7ff)));
      for (let k = 0; k < 3; k++) g.add(mesh(geo('tor', () => new THREE.TorusGeometry(1, 0.2, 6, 16)), toon(0x2f5fb3), 0, -0.35 + k * 0.28, 0, prof[k + 1] + 0.005, prof[k + 1] + 0.005, 0.1).rotateX(Math.PI / 2));
      g.add(mesh(SPHERE(), toon(0xff6f91), 0, 0.72, 0, 0.12, 0.12, 0.12));
      for (let k = 0; k < 4; k++) {
        const c = mesh(new THREE.BoxGeometry(0.02, 0.35, 0.01), toon(0x333333), (k - 1.5) * 0.12, -0.1 + (k % 2) * 0.3, 0.33);
        c.rotation.z = (k % 2 ? 0.5 : -0.4);
        c.visible = false;
        g.add(c);
        this.cracks.push(c);
      }
      this.parts.push(g);
    } else {
      const tray = mesh(new THREE.BoxGeometry(1.5, 0.14, 0.9), toon(0x8b5a2b));
      this.parts.push(tray);
      for (let k = 0; k < 5; k++) {
        const p = new THREE.Group();
        p.add(mesh(CYL(), toon(0xffffff), 0, 0, 0, 0.6, 0.1, 0.45));
        p.add(mesh(CYL(), toon(0x4dc3ff), 0, 0.051, 0, 0.45, 0.005, 0.33));
        this.parts.push(p);
      }
    }
    this.parts.forEach((p) => {
      p.traverse((o) => ((o as THREE.Mesh).castShadow = true));
      this.group.add(p);
    });
  }

  /** Returns number of newly lost cake layers since last call (for effects). */
  update(parts: number[], damage: number, slosh: number, t: number) {
    this.parts.forEach((p, k) => {
      const x = parts[k * 3];
      const y = parts[k * 3 + 1];
      p.visible = x < 1e4;
      p.position.set(x, y, 0);
      p.rotation.z = parts[k * 3 + 2];
    });
    if (this.kind === 'cake') {
      const lost = Math.min(2, Math.floor(damage / 34));
      this.layers.forEach((l, k) => {
        // Damaged layers slump and slide instead of vanishing.
        const hurt = k >= 3 - lost;
        l.rotation.z = hurt ? (k % 2 ? 0.18 : -0.15) : 0;
        l.position.x = hurt ? (k % 2 ? 0.12 : -0.1) : 0;
        l.scale.y = hurt ? 0.75 : 1;
      });
    } else if (this.kind === 'fishtank' && this.water && this.fish) {
      const level = Math.max(0.15, 1 - damage / 120);
      this.water.scale.y = level;
      this.water.rotation.z = -slosh * 0.35;
      this.fish.position.set(Math.sin(t * 1.3) * 0.4, -0.2 + level * 0.25 + Math.sin(t * 3) * 0.05, 0.46);
      this.fish.rotation.y = Math.cos(t * 1.3) > 0 ? 0 : Math.PI;
    } else if (this.kind === 'vase') {
      const n = Math.floor(damage / 22);
      this.cracks.forEach((c, k) => (c.visible = k < n));
    }
  }
}

// ------------------------------------------------------------------ rope

export class RopeView {
  readonly mesh: THREE.InstancedMesh;
  private dummy = new THREE.Object3D();
  private color = new THREE.Color();
  private max: number;
  constructor(maxLinks: number) {
    this.max = maxLinks;
    const g = new THREE.CylinderGeometry(0.065, 0.065, 1, 6, 1).rotateZ(Math.PI / 2);
    this.mesh = new THREE.InstancedMesh(g, toon(0xffffff), maxLinks);
    this.mesh.castShadow = true;
    this.mesh.frustumCulled = false;
  }

  /** chains: list of polylines (player → segments → player) and a rope style per chain. */
  update(chains: { pts: number[]; style: string }[]) {
    let n = 0;
    for (const ch of chains) {
      const style = ROPES.find((r) => r.id === ch.style) ?? ROPES[0];
      const pts = ch.pts;
      for (let k = 0; k + 3 < pts.length; k += 2) {
        const x1 = pts[k];
        const y1 = pts[k + 1];
        const x2 = pts[k + 2];
        const y2 = pts[k + 3];
        const len = Math.hypot(x2 - x1, y2 - y1);
        this.dummy.position.set((x1 + x2) / 2, (y1 + y2) / 2, 0);
        this.dummy.rotation.set(0, 0, Math.atan2(y2 - y1, x2 - x1));
        this.dummy.scale.set(len + 0.04, 1, 1);
        this.dummy.updateMatrix();
        if (n >= this.max) break;
        this.mesh.setMatrixAt(n, this.dummy.matrix);
        this.color.setHex(style.colors[(k / 2) % style.colors.length]);
        this.mesh.setColorAt(n, this.color);
        n++;
      }
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}
