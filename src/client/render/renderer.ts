import * as THREE from 'three';
import { BODY_COLORS } from '../../shared/cosmetics';
import { PING_TEXT, QUICK_CHAT, type CourseDef, type CrewMember, type GameEvent, type Snapshot } from '../../shared/types';
import { CargoView, CharacterView, RopeView } from './actors';
import { Particles } from './fx';
import { disposeTree } from './materials';
import { buildWorld, type WorldView } from './world';

const EMOTE_TEXT: Record<string, string> = { highfive: '✋ High five!', blame: '👉 Your fault!', cheer: '🎉 Woo!', facepalm: '🤦' };
const PING_ICON: Record<string, string> = { go: '📍', wait: '✋', grab: '🤲', jump: '⬆️', help: '🆘' };

interface Label {
  el: HTMLDivElement;
  x: number;
  y: number;
  follow?: number; // player index
  until: number;
  rise?: number;
  text: string;
  kind: string;
  color?: string;
}

export type Quality = 'low' | 'high';

export class GameRenderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(34, 1, 0.5, 400);
  private sun: THREE.DirectionalLight;
  private world?: WorldView;
  private chars: CharacterView[] = [];
  private cargo?: CargoView;
  private rope = new RopeView(400);
  readonly particles = new Particles();
  private course?: CourseDef;
  private crew: CrewMember[] = [];
  private labels: Label[] = [];
  private nameTags: HTMLDivElement[] = [];
  private camPos = new THREE.Vector3(0, 3, 16);
  private camLook = new THREE.Vector3(0, 0, 0);
  private camInit = false;
  private shake = 0;
  private windT = 0;
  private lastSnap?: Snapshot;
  localSlots: number[] = [];
  blocked = new Set<string>();
  /** Shift the picture sideways (fraction of the width), e.g. to make room for the menu. */
  focusShift = 0;
  private shiftNow = 0;
  quality: Quality;

  constructor(
    readonly canvas: HTMLCanvasElement,
    readonly labelLayer: HTMLElement,
    quality: Quality,
  ) {
    this.quality = quality;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: quality === 'high', preserveDrawingBuffer: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, quality === 'high' ? 1.5 : 1));
    this.renderer.shadowMap.enabled = quality === 'high';
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0xb0a090, 1.6));
    this.sun = new THREE.DirectionalLight(0xffffff, 1.6);
    this.sun.position.set(-6, 14, 12);
    this.sun.castShadow = quality === 'high';
    this.sun.shadow.mapSize.set(1024, 1024);
    const sc = this.sun.shadow.camera;
    sc.left = -14;
    sc.right = 14;
    sc.top = 10;
    sc.bottom = -10;
    sc.near = 1;
    sc.far = 60;
    this.sun.shadow.bias = -0.002;
    this.scene.add(this.sun, this.sun.target);
    this.scene.add(this.rope.mesh);
    this.scene.add(this.particles.points);
    this.resize();
  }

  setQuality(q: Quality) {
    this.quality = q;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, q === 'high' ? 1.5 : 1));
    this.renderer.shadowMap.enabled = q === 'high';
    this.sun.castShadow = q === 'high';
    this.resize();
  }

  /** Jump the camera straight to its target on the next frame (no easing). */
  snapCamera() {
    this.camInit = false;
  }

  resize() {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.particles.setScale(h * 0.9);
  }

  setCourse(course: CourseDef, crew: CrewMember[]) {
    this.clearCourse();
    this.course = course;
    this.world = buildWorld(course, this.scene);
    if (this.quality === 'high') this.world.root.traverse((o) => ((o as THREE.Mesh).receiveShadow = true));
    this.cargo = new CargoView(course.cargo);
    this.scene.add(this.cargo.group);
    this.setCrew(crew);
    this.camInit = false;
  }

  setCrew(crew: CrewMember[]) {
    this.crew = crew;
    while (this.chars.length > crew.length) {
      const c = this.chars.pop()!;
      this.scene.remove(c.group);
      disposeTree(c.group);
    }
    crew.forEach((m, i) => {
      if (!this.chars[i]) {
        this.chars[i] = new CharacterView(m.look);
        this.chars[i].lane = (i % 2 ? 0.12 : -0.12) * (i > 1 ? 2 : 1);
        this.scene.add(this.chars[i].group);
      } else this.chars[i].setLook(m.look);
    });
    this.nameTags.forEach((t) => t.remove());
    this.nameTags = crew.map((m, i) => {
      const el = document.createElement('div');
      el.className = 'nametag' + (this.localSlots.includes(i) ? ' me' : '') + (m.bot ? ' bot' : '');
      el.style.setProperty('--c', '#' + BODY_COLORS[m.look.body].toString(16).padStart(6, '0'));
      el.textContent = m.name;
      this.labelLayer.appendChild(el);
      return el;
    });
  }

  clearCourse() {
    this.world?.dispose();
    this.world = undefined;
    if (this.cargo) {
      this.scene.remove(this.cargo.group);
      disposeTree(this.cargo.group);
    }
    this.cargo = undefined;
    this.chars.forEach((c) => {
      this.scene.remove(c.group);
      disposeTree(c.group);
    });
    this.chars = [];
    this.nameTags.forEach((t) => t.remove());
    this.nameTags = [];
    this.labels.forEach((l) => l.el.remove());
    this.labels = [];
    this.rope.update([]);
  }

  // ---------------------------------------------------------------- events → effects

  handleEvents(events: GameEvent[], s: Snapshot) {
    const P = (i: number) => s.players[i];
    for (const e of events) {
      switch (e.e) {
        case 'land':
          if (P(e.p)) this.particles.emit(P(e.p).x, P(e.p).y - 0.35, 6, 0xd8cfc0, { speed: 2, up: 0.5, size: 0.14, life: 0.4 });
          break;
        case 'grab':
          this.particles.emit(e.x, e.y, 4, 0xffffff, { speed: 1.5, up: 0.5, size: 0.08, life: 0.25 });
          break;
        case 'panic':
          if (P(e.p)) this.float(P(e.p).x, P(e.p).y + 0.9, 'PANIC GRAB!', 'big', '#ffd23b');
          break;
        case 'ouch': {
          const p = P(e.p);
          if (!p) break;
          if (e.kind === 'heat') this.particles.emit(p.x, p.y - 0.3, 14, [0xff5a1f, 0xffb13b, 0x555555], { speed: 2.5, up: 3, size: 0.16 });
          else if (e.kind === 'water') this.particles.emit(p.x, p.y + 0.3, 14, [0x7fd0ff, 0xffffff], { speed: 3, up: 1, size: 0.12 });
          else this.particles.emit(p.x, p.y, 10, 0xffffff, { speed: 4, up: 1, size: 0.12 });
          this.bubble(e.p, e.kind === 'heat' ? 'HOT HOT HOT!' : e.kind === 'water' ? 'Blub!' : 'Oof!', 'ouch');
          this.shake = Math.max(this.shake, 0.15);
          break;
        }
        case 'damage':
          this.float(e.x, e.y + 0.8, `-${e.amount}%`, 'dmg', '#ff4d4d');
          this.particles.emit(e.x, e.y, Math.min(20, 3 + e.amount), this.crumbColors(), { speed: 3, up: 2, size: 0.12 });
          if (e.amount >= 5) this.shake = Math.max(this.shake, Math.min(0.5, e.amount * 0.03));
          break;
        case 'layer':
          this.particles.emit(e.x, e.y + 0.3, 24, this.crumbColors(), { speed: 4, up: 3, size: 0.16, life: 1.2 });
          break;
        case 'checkpoint':
          this.float(e.x, e.y + 2.4, 'CHECKPOINT!', 'big', '#3ddc84');
          this.particles.emit(e.x, e.y + 1.8, 30, [0x3ddc84, 0xffd23b, 0xffffff], { speed: 4, up: 3, size: 0.14, life: 1 });
          break;
        case 'drop':
          this.float(e.x, e.y + 2, 'DROPPED IT!', 'big', '#ff4d4d');
          this.shake = 0.6;
          break;
        case 'fell':
          if (P(e.p)) this.bubble(e.p, 'Aaaaah!', 'ouch');
          break;
        case 'collect':
          this.float(e.x, e.y + 0.6, '+5 ⭐', 'coin', '#ffd23b');
          this.particles.emit(e.x, e.y, 16, [0xffd23b, 0xffffff], { speed: 3, up: 1, size: 0.12, gravity: -4 });
          break;
        case 'delivered': {
          const c = this.course!.goal;
          for (let k = 0; k < 6; k++) this.particles.emit(c.x + (k - 3), c.y + 2, 25, [0xff5a7a, 0xffd93b, 0x4dc3ff, 0x7bd389, 0xab47bc], { speed: 6, up: 6, size: 0.14, life: 2, gravity: -6 });
          break;
        }
        case 'kick':
          this.particles.emit(e.x, e.y, 8, 0x7ccf5a, { speed: 3, up: 1, size: 0.1 });
          break;
        case 'ping': {
          if (this.isBlocked(e.p)) break;
          const el = this.addLabel(e.x, e.y, `${PING_ICON[e.kind]}`, 'pingmark', 3);
          el.style.setProperty('--c', this.colorOf(e.p));
          this.bubble(e.p, PING_TEXT[e.kind], 'ping');
          break;
        }
        case 'emote':
          if (this.isBlocked(e.p)) break;
          this.chars[e.p]?.playEmote(e.kind);
          this.bubble(e.p, e.kind === 'blame' && e.target !== undefined ? `👉 ${this.crew[e.target]?.name ?? ''}!` : EMOTE_TEXT[e.kind], 'emote');
          break;
        case 'chat':
          if (this.isBlocked(e.p)) break;
          this.bubble(e.p, QUICK_CHAT[e.i] ?? '…', 'chat');
          break;
        default:
          break;
      }
    }
  }

  private isBlocked(p: number) {
    const m = this.crew[p];
    return !!m && this.blocked.has(m.id);
  }

  private colorOf(p: number) {
    const m = this.crew[p];
    return '#' + BODY_COLORS[m?.look.body ?? 0].toString(16).padStart(6, '0');
  }

  private crumbColors() {
    switch (this.course?.cargo) {
      case 'cake':
        return [0x9b5b3a, 0xf7c4d6, 0xfff1d6, 0xff5a7a, 0x4dc3ff];
      case 'fishtank':
        return [0x7fd0ff, 0xffffff, 0x4db8ff];
      case 'vase':
        return [0xf4f7ff, 0x2f5fb3];
      default:
        return [0xffffff, 0xdddddd, 0x4dc3ff];
    }
  }

  private addLabel(x: number, y: number, text: string, kind: string, secs: number, follow?: number, rise = 0): HTMLDivElement {
    const el = document.createElement('div');
    el.className = 'lbl ' + kind;
    el.textContent = text;
    this.labelLayer.appendChild(el);
    this.labels.push({ el, x, y, follow, until: performance.now() + secs * 1000, rise, text, kind });
    return el;
  }

  bubble(p: number, text: string, kind: string) {
    // One bubble per player at a time.
    this.labels = this.labels.filter((l) => {
      if (l.follow === p && l.kind.startsWith('bubble')) {
        l.el.remove();
        return false;
      }
      return true;
    });
    const el = this.addLabel(0, 0, text, 'bubble ' + kind, 2.2, p);
    el.style.setProperty('--c', this.colorOf(p));
  }

  float(x: number, y: number, text: string, kind: string, color: string) {
    const el = this.addLabel(x, y, text, 'float ' + kind, 1.3, undefined, 1.2);
    el.style.color = color;
    const l = this.labels[this.labels.length - 1];
    l.color = color;
  }

  // ---------------------------------------------------------------- frame

  render(s: Snapshot, dt: number, t: number) {
    if (!this.course || !this.world || !this.cargo) return;
    this.lastSnap = s;
    this.world.update(s, t, dt);
    s.players.forEach((p, i) => this.chars[i]?.update(p, dt, t, s.cargo.parts[0]));
    this.cargo.update(s.cargo.parts, s.cargo.damage, s.cargo.slosh, t);

    // Rope chains: player → segments → player
    const chains = s.rope.map((segs, k) => {
      const a = s.players[k];
      const b = s.players[k + 1];
      return { pts: a && b ? [a.x, a.y, ...segs, b.x, b.y] : segs, style: this.crew[k]?.look.rope ?? 'classic' };
    });
    this.rope.update(chains);

    // Wind streaks
    this.windT += dt;
    if (this.windT > 0.05) {
      this.windT = 0;
      this.course.zones.forEach((z, i) => {
        if (z.kind === 'wind' && s.zonesOn & (1 << i)) this.particles.wind(z.x, z.y, z.w, z.h, z.fx ?? 0);
        if (z.kind === 'heat' && s.zonesOn & (1 << i) && Math.random() < 0.5) this.particles.emit(z.x, z.y - z.h / 2 + 0.1, 1, [0xff7a1f, 0xffc04d], { speed: 0.4, up: 1.5, size: 0.1, gravity: 1, spread: z.w * 0.6 });
      });
    }
    this.particles.update(dt);
    this.updateCamera(s, dt);
    this.renderer.render(this.scene, this.camera);
    this.updateLabels(s);
  }

  private updateCamera(s: Snapshot, dt: number) {
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    const add = (x: number, y: number) => {
      if (!(Math.abs(x) < 1e4)) return;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    };
    s.players.forEach((p) => add(p.x, p.y));
    add(s.cargo.parts[0], s.cargo.parts[1]);
    if (!Number.isFinite(minX)) return;
    const cx = (minX + maxX) / 2 + 1.2;
    const cy = (minY + maxY) / 2 + 0.6;
    const w = maxX - minX + 7;
    const h = maxY - minY + 5;
    const tan = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    const dist = THREE.MathUtils.clamp(Math.max(h / (2 * tan), w / (2 * tan * this.camera.aspect)), 11, 34);
    const target = new THREE.Vector3(cx, cy + dist * 0.16, dist);
    const look = new THREE.Vector3(cx, cy, 0);
    if (!this.camInit) {
      this.camPos.copy(target);
      this.camLook.copy(look);
      this.camInit = true;
    }
    const k = 1 - Math.exp(-dt * 3.2);
    this.camPos.lerp(target, k);
    this.camLook.lerp(look, k);
    this.shake *= Math.pow(0.02, dt);
    const sh = this.shake;
    this.camera.position.set(this.camPos.x + (Math.random() - 0.5) * sh, this.camPos.y + (Math.random() - 0.5) * sh, this.camPos.z);
    this.camera.lookAt(this.camLook);
    this.shiftNow += (this.focusShift - this.shiftNow) * Math.min(1, dt * 4);
    const cw = this.canvas.clientWidth || 1;
    const ch = this.canvas.clientHeight || 1;
    if (Math.abs(this.shiftNow) > 0.001) this.camera.setViewOffset(cw, ch, -this.shiftNow * cw, 0, cw, ch);
    else this.camera.clearViewOffset();
    this.sun.position.set(this.camLook.x - 6, this.camLook.y + 14, 12);
    this.sun.target.position.set(this.camLook.x, this.camLook.y, 0);
  }

  private v = new THREE.Vector3();
  worldToScreen(x: number, y: number, z = 0) {
    this.v.set(x, y, z).project(this.camera);
    const r = this.canvas.getBoundingClientRect();
    return { x: ((this.v.x + 1) / 2) * r.width, y: ((1 - this.v.y) / 2) * r.height, behind: this.v.z > 1 };
  }

  screenToWorld(px: number, py: number) {
    const r = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector3(((px - r.left) / r.width) * 2 - 1, -((py - r.top) / r.height) * 2 + 1, 0.5);
    ndc.unproject(this.camera);
    const dir = ndc.sub(this.camera.position).normalize();
    const t = -this.camera.position.z / dir.z;
    return { x: this.camera.position.x + dir.x * t, y: this.camera.position.y + dir.y * t };
  }

  private updateLabels(s: Snapshot) {
    const now = performance.now();
    const placed: { x: number; y: number }[] = [];
    s.players.forEach((p, i) => {
      const tag = this.nameTags[i];
      if (!tag) return;
      const sc = this.worldToScreen(p.x, p.y + 0.75);
      // Stack tags that would overlap.
      let y = sc.y;
      for (let k = 0; k < 4 && placed.some((q) => Math.abs(q.x - sc.x) < 90 && Math.abs(q.y - y) < 18); k++) y -= 19;
      placed.push({ x: sc.x, y });
      tag.style.transform = `translate(${sc.x}px, ${y}px) translate(-50%, -100%)`;
      tag.classList.toggle('panic-used', !!p.pu);
      tag.classList.toggle('tired', p.st < 0.35);
    });
    this.labels = this.labels.filter((l) => {
      if (now > l.until) {
        l.el.remove();
        return false;
      }
      let x = l.x;
      let y = l.y;
      if (l.follow !== undefined) {
        const p = s.players[l.follow];
        if (!p) return true;
        x = p.x;
        y = p.y + 1.25;
      }
      const left = (l.until - now) / 1000;
      if (l.rise) y += (1.3 - left) * l.rise;
      const sc = this.worldToScreen(x, y);
      l.el.style.transform = `translate(${sc.x}px, ${sc.y}px) translate(-50%, -100%)`;
      l.el.style.opacity = String(Math.min(1, left * 3));
      return true;
    });
  }

  /** Draw name tags and bubbles into a 2D context (used when exporting clips). */
  drawOverlay(g: CanvasRenderingContext2D, scale: number) {
    const s = this.lastSnap;
    if (!s) return;
    g.save();
    g.textAlign = 'center';
    g.textBaseline = 'bottom';
    g.font = `bold ${Math.round(14 * scale)}px system-ui, sans-serif`;
    s.players.forEach((p, i) => {
      const sc = this.worldToScreen(p.x, p.y + 0.75);
      g.fillStyle = 'rgba(0,0,0,0.45)';
      const name = this.crew[i]?.name ?? '';
      const w = g.measureText(name).width + 12 * scale;
      g.fillRect(sc.x * scale - w / 2, sc.y * scale - 20 * scale, w, 20 * scale);
      g.fillStyle = '#fff';
      g.fillText(name, sc.x * scale, sc.y * scale - 3 * scale);
    });
    for (const l of this.labels) {
      if (!l.kind.startsWith('bubble') && !l.kind.startsWith('float')) continue;
      const m = l.el.style.transform.match(/translate\(([-\d.]+)px, ([-\d.]+)px\)/);
      if (!m) continue;
      const x = Number(m[1]) * scale;
      const y = Number(m[2]) * scale;
      g.font = `bold ${Math.round((l.kind.includes('big') ? 26 : 16) * scale)}px system-ui, sans-serif`;
      if (l.kind.startsWith('bubble')) {
        const w = g.measureText(l.text).width + 16 * scale;
        g.fillStyle = '#fff';
        g.beginPath();
        g.roundRect(x - w / 2, y - 28 * scale, w, 26 * scale, 10 * scale);
        g.fill();
        g.fillStyle = '#222';
        g.fillText(l.text, x, y - 6 * scale);
      } else {
        g.fillStyle = l.color ?? '#fff';
        g.strokeStyle = 'rgba(0,0,0,0.6)';
        g.lineWidth = 4 * scale;
        g.strokeText(l.text, x, y);
        g.fillText(l.text, x, y);
      }
    }
    g.restore();
  }
}
