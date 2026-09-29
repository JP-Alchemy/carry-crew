import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { CourseDef, Decor, Snapshot, Solid } from '../../shared/types';
import { BOX, CONE, CYL, SPHERE, basic, box, geo, mesh, textTexture, toon, toonUnique } from './materials';

const BOOK_COLORS = [0xe4572e, 0x29335c, 0xf3a712, 0x669bbc, 0x8cb369, 0xa8201a, 0x7b4b94];
const BLOCK_COLORS = [0xff595e, 0xffca3a, 0x8ac926, 0x1982c4, 0x6a4c93, 0xff924c];

function hash(n: number) {
  const s = Math.sin(n * 12.9898) * 43758.5453;
  return s - Math.floor(s);
}

function rbox(w: number, h: number, d: number, r = 0.08) {
  const key = `rb${w.toFixed(2)}_${h.toFixed(2)}_${d.toFixed(2)}_${r}`;
  return geo(key, () => new RoundedBoxGeometry(w, h, d, 2, Math.min(r, w / 2 - 0.001, h / 2 - 0.001, d / 2 - 0.001)));
}

/** Build the mesh for one static solid. Play plane is z = 0; big furniture extends back into the room. */
function solidMesh(s: Solid, i: number): THREE.Object3D | null {
  if (s.tag === 'invisible') return null;
  const g = new THREE.Group();
  g.position.set(s.x, s.y, 0);
  g.rotation.z = s.a ?? 0;
  const { w, h } = s;
  const deep = (d: number, zc: number, color: number, r = 0.06) => {
    const m = new THREE.Mesh(rbox(w, h, d, r), toon(color));
    m.position.z = zc;
    g.add(m);
    return m;
  };
  if (s.round) {
    g.add(mesh(SPHERE(), toon(0xcccccc), 0, 0, 0, w / 2, w / 2, w / 2));
    return g;
  }
  switch (s.mat) {
    case 'counter': {
      const top = 0.18;
      const body = new THREE.Mesh(BOX(), toon(0x9cc9d6));
      body.scale.set(w, h - top, 3.2);
      body.position.set(0, -top / 2, -0.75);
      g.add(body);
      const slab = new THREE.Mesh(BOX(), toon(0xf6f1e7));
      slab.scale.set(w + 0.1, top, 3.4);
      slab.position.set(0, h / 2 - top / 2, -0.75);
      g.add(slab);
      // Cupboard doors and handles on the front face
      const doors = Math.max(1, Math.round(w / 2.4));
      const dw = w / doors;
      for (let k = 0; k < doors; k++) {
        const x = -w / 2 + dw * (k + 0.5);
        const dh = Math.min(h - 0.6, 3.2);
        g.add(box(0xb5dbe5, dw - 0.25, dh, 0.06, x, h / 2 - top - 0.3 - dh / 2, 0.87));
        g.add(box(0x6e7f86, 0.08, 0.5, 0.1, x + (k % 2 ? -1 : 1) * (dw / 2 - 0.35), h / 2 - top - 0.8, 0.95));
      }
      return g;
    }
    case 'stove': {
      const top = 0.2;
      g.add(box(0xe7e7ea, w, h - top, 3.2, 0, -top / 2, -0.75));
      g.add(box(0x2b2b30, w + 0.05, top, 3.4, 0, h / 2 - top / 2, -0.75));
      g.add(box(0x333338, w - 1, Math.min(2.4, h - 1), 0.06, 0, h / 2 - top - 1.6, 0.87));
      g.add(box(0x8a5a2a, w - 1.6, Math.min(1.6, h - 1.8), 0.08, 0, h / 2 - top - 1.6, 0.9));
      for (let k = -1; k <= 1; k++) g.add(mesh(CYL(), toon(0x999999), k * 1.4, h / 2 - 0.12, 0.95, 0.14, 0.12, 0.14).rotateX(Math.PI / 2));
      return g;
    }
    case 'metal':
      deep(2.6, -0.5, 0xb8c0c8, 0.02);
      return g;
    case 'jar': {
      const fill = s.tag === 'jam' ? 0xc8324a : 0xe8a33b;
      const r = w / 2;
      g.add(mesh(CYL(), toon(fill), 0, -0.06, 0, r * 0.9, h - 0.2, r * 0.9));
      g.add(mesh(CYL(), toon(0xdff3f8, { opacity: 0.45 }), 0, -0.04, 0, r, h - 0.08, r));
      g.add(mesh(CYL(), toon(s.tag === 'jam' ? 0xffffff : 0xd9443b), 0, h / 2 - 0.06, 0, r * 0.95, 0.14, r * 0.95));
      if (s.tag === 'jam') g.add(mesh(CYL(), toon(0xe24a4a), 0, h / 2 - 0.02, 0, r * 0.96, 0.06, r * 0.96));
      const lbl = new THREE.Mesh(new THREE.PlaneGeometry(r * 1.2, h * 0.35), new THREE.MeshBasicMaterial({ map: textTexture(s.tag === 'jam' ? 'JAM' : 'HONEY', { bg: '#fff7e0', color: '#6b3b12' }) }));
      lbl.position.set(0, -0.05, r + 0.01);
      g.add(lbl);
      return g;
    }
    case 'box': {
      deep(0.9, 0, 0xf2c14e, 0.03);
      g.add(box(0xe4572e, w * 0.98, h * 0.3, 0.02, 0, h * 0.12, 0.46));
      const lbl = new THREE.Mesh(new THREE.PlaneGeometry(w * 0.8, h * 0.28), new THREE.MeshBasicMaterial({ map: textTexture('CRUNCH-O', { color: '#fff' }), transparent: true }));
      lbl.position.set(0, h * 0.12, 0.475);
      g.add(lbl);
      return g;
    }
    case 'book': {
      const n = Math.max(1, Math.round(h / 0.3));
      const bh = h / n;
      for (let k = 0; k < n; k++) {
        const c = BOOK_COLORS[Math.floor(hash(i * 7 + k) * BOOK_COLORS.length)];
        const inset = hash(i * 3 + k) * 0.15;
        const b = new THREE.Mesh(rbox(w - inset, bh - 0.01, 1.6, 0.04), toon(c));
        b.position.set((hash(k + i) - 0.5) * 0.1, -h / 2 + bh * (k + 0.5), -0.2);
        g.add(b);
        g.add(box(0xfaf3e0, w - inset - 0.1, bh * 0.7, 0.02, b.position.x, b.position.y, 0.61));
      }
      return g;
    }
    case 'toaster':
      g.add(new THREE.Mesh(rbox(w, h, 1.2, 0.25), toon(0xd6dde4)));
      g.add(box(0x222222, w * 0.6, 0.05, 0.14, 0, h / 2, 0.2));
      g.add(box(0x222222, w * 0.6, 0.05, 0.14, 0, h / 2, -0.2));
      g.add(box(0x333333, 0.12, 0.3, 0.12, w / 2 + 0.05, 0.1, 0.3));
      return g;
    case 'spoon':
      deep(0.5, 0, 0xc8914f, 0.1);
      g.add(mesh(SPHERE(), toon(0xc8914f), w / 2 - 0.2, 0.05, 0, 0.7, 0.18, 0.45));
      return g;
    case 'board':
      deep(1.2, 0, 0xd6a15c, 0.08);
      return g;
    case 'table':
      deep(3.4, -0.8, 0xa0673c, 0.05);
      g.add(box(0xfff5f5, w + 0.05, 0.04, 3.45, 0, h / 2 + 0.01, -0.8));
      return g;
    case 'rack': {
      deep(1.4, 0, 0xe8e8e8, 0.05);
      for (let x = -w / 2 + 0.3; x < w / 2; x += 0.45) g.add(box(0xcfcfcf, 0.05, 0.5, 1.2, x, 0.3, 0));
      return g;
    }
    case 'plate':
      g.add(mesh(CYL(), toon(0xffffff), 0, 0, 0, w / 2, h, 0.5));
      return g;
    case 'desk': {
      const top = 0.25;
      g.add(box(0xb07d4f, w, h - top, 3, 0, -top / 2, -0.8));
      g.add(box(0xd6a36c, w + 0.1, top, 3.2, 0, h / 2 - top / 2, -0.8));
      const drawers = Math.max(1, Math.round(w / 3));
      for (let k = 0; k < drawers; k++) {
        const x = -w / 2 + (w / drawers) * (k + 0.5);
        g.add(box(0xc48d5a, w / drawers - 0.3, 1.1, 0.06, x, h / 2 - top - 0.8, 0.72));
        g.add(box(0x5b3a1e, 0.6, 0.1, 0.1, x, h / 2 - top - 0.8, 0.78));
      }
      return g;
    }
    case 'bed': {
      g.add(box(0xf4f4f8, w, h - 0.5, 3.4, 0, -0.25, -0.9));
      const blanket = new THREE.Mesh(rbox(w + 0.1, 0.6, 3.5, 0.25), toon(0x6fa8dc));
      blanket.position.set(0, h / 2 - 0.3, -0.9);
      g.add(blanket);
      for (let x = -w / 2 + 0.8; x < w / 2; x += 1.6) g.add(box(0xffffff, 0.6, 0.06, 0.02, x, h / 2 - 0.3, 0.87));
      return g;
    }
    case 'shelf':
      deep(1.8, -0.4, 0xe0c090, 0.04);
      return g;
    case 'toyblock': {
      const c = BLOCK_COLORS[i % BLOCK_COLORS.length];
      g.add(new THREE.Mesh(rbox(w, h, Math.min(1.2, w), 0.06), toon(c)));
      return g;
    }
    case 'grass': {
      const top = 0.3;
      g.add(box(0x8b5a2b, w, h - top, 3, 0, -top / 2, -0.8));
      g.add(box(0x6cc24a, w + 0.02, top, 3.2, 0, h / 2 - top / 2, -0.8));
      return g;
    }
    case 'sand':
      g.add(box(0xf2d38b, w, h, 3, 0, 0, -0.8));
      g.add(box(0xc9a05c, 0.3, h + 0.2, 3.1, -w / 2, 0.1, -0.8));
      g.add(box(0xc9a05c, 0.3, h + 0.2, 3.1, w / 2, 0.1, -0.8));
      return g;
    case 'mud':
      g.add(box(0x5c4027, w, h, 3, 0, 0, -0.8));
      return g;
    case 'bucket':
      g.add(mesh(CYL(), toon(0xff5a5a), 0, 0, 0, w / 2, h, w / 2));
      g.add(mesh(CYL(), toon(0xf2d38b), 0, h / 2 - 0.02, 0, w / 2 - 0.05, 0.02, w / 2 - 0.05));
      return g;
    case 'wood':
      deep(1.4, 0, 0xb5763c, 0.05);
      return g;
    case 'slide':
      deep(1.6, 0, 0xff4f4f, 0.1);
      g.add(box(0xd93b3b, w, 0.35, 0.12, 0, 0.2, 0.8));
      g.add(box(0xd93b3b, w, 0.35, 0.12, 0, 0.2, -0.8));
      return g;
    case 'tyre':
      g.add(mesh(geo('torus', () => new THREE.TorusGeometry(1, 0.35, 8, 20)), toon(0x2b2b2b), 0, 0, 0, w * 0.45, w * 0.45, w * 0.45).rotateX(Math.PI / 2));
      return g;
    case 'bench':
      deep(1.4, 0, 0x4c8c4a, 0.05);
      return g;
    case 'floor':
      return null; // drawn by the backdrop
    default:
      deep(1.5, 0, 0xcccccc);
      return g;
  }
}

function signMesh(text: string, w: number, h: number, bg = '#ffffff', color = '#333333') {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: textTexture(text, { bg, color }), transparent: true }));
  return m;
}

function decorMesh(d: Decor): THREE.Object3D {
  const g = new THREE.Group();
  g.position.set(d.x, d.y, d.z);
  g.scale.setScalar(d.s);
  if (d.r) g.rotation.y = d.r;
  switch (d.kind) {
    case 'window': {
      g.add(box(0xffffff, 4.4, 3.4, 0.2));
      g.add(box(0xbfe6ff, 4, 3, 0.1, 0, 0, 0.08));
      g.add(box(0xffffff, 0.15, 3, 0.15, 0, 0, 0.12));
      g.add(box(0xffffff, 4, 0.15, 0.15, 0, 0, 0.12));
      g.add(box(0xff8fa3, 1.2, 3.3, 0.1, -2.6, 0, 0.2));
      g.add(box(0xff8fa3, 1.2, 3.3, 0.1, 2.6, 0, 0.2));
      break;
    }
    case 'cabinet':
      g.add(box(0x9cc9d6, 5.5, 2.4, 1));
      g.add(box(0xb5dbe5, 2.5, 2, 0.06, -1.35, 0, 0.52));
      g.add(box(0xb5dbe5, 2.5, 2, 0.06, 1.35, 0, 0.52));
      break;
    case 'kettle':
      g.add(mesh(SPHERE(), toon(0xe05a47), 0, 0.55, 0, 0.6, 0.55, 0.6));
      g.add(mesh(CYL(), toon(0x333333), 0, 1.1, 0, 0.18, 0.15, 0.18));
      g.add(mesh(CYL(), toon(0xe05a47), 0.65, 0.7, 0, 0.08, 0.6, 0.08).rotateZ(-0.9));
      break;
    case 'jar':
      g.add(mesh(CYL(), toon(d.c ?? 0xe8a33b), 0, 0.5, 0, 0.35, 1, 0.35));
      g.add(mesh(CYL(), toon(0xffffff), 0, 1.05, 0, 0.37, 0.12, 0.37));
      break;
    case 'utensils':
      g.add(mesh(CYL(), toon(0x8a9ba8), 0, 0.5, 0, 0.35, 1, 0.35));
      for (let k = -1; k <= 1; k++) g.add(mesh(CYL(), toon(0xc8914f), k * 0.15, 1.3, 0, 0.05, 1.2, 0.05).rotateZ(k * 0.2));
      break;
    case 'plant':
      g.add(mesh(CYL(), toon(0xd9794a), 0, 0.4, 0, 0.4, 0.8, 0.35));
      for (let k = 0; k < 5; k++) g.add(mesh(SPHERE(), toon(0x5fae4b), Math.cos(k) * 0.35, 1.1 + hash(k) * 0.4, Math.sin(k) * 0.2, 0.35, 0.5, 0.3));
      break;
    case 'hood':
      g.add(box(0xc8ccd0, 5, 1.2, 1.6));
      g.add(box(0xb0b5ba, 1.6, 3, 1, 0, 2, -0.3));
      break;
    case 'pan':
      g.add(mesh(CYL(), toon(0x333333), 0, 0.15, 0, 0.7, 0.3, 0.7));
      g.add(box(0x333333, 1, 0.1, 0.12, 1.1, 0.25, 0));
      break;
    case 'tap': {
      g.add(mesh(CYL(), toon(0xc0c7ce), 0, 1.3, -0.3, 0.12, 2.6, 0.12));
      g.add(mesh(CYL(), toon(0xc0c7ce), 0.0, 2.6, 0.1, 0.1, 0.9, 0.1).rotateX(Math.PI / 2));
      g.add(mesh(SPHERE(), toon(0xc0c7ce), 0, 2.6, -0.3, 0.16, 0.16, 0.16));
      break;
    }
    case 'rack':
      break;
    case 'cat': {
      const fur = toon(0xf0a04b);
      g.add(mesh(SPHERE(), fur, 0, 2.2, 0, 1.8, 2.2, 1.4));
      g.add(mesh(SPHERE(), fur, -0.4, 4.6, 0.4, 1.2, 1.1, 1.1));
      g.add(mesh(CONE(), fur, -1.2, 5.6, 0.4, 0.4, 0.9, 0.3).rotateZ(0.3));
      g.add(mesh(CONE(), fur, 0.3, 5.7, 0.4, 0.4, 0.9, 0.3).rotateZ(-0.3));
      g.add(mesh(SPHERE(), toon(0xffffff), -0.9, 4.8, 1.35, 0.28, 0.32, 0.1));
      g.add(mesh(SPHERE(), toon(0xffffff), 0.1, 4.8, 1.35, 0.28, 0.32, 0.1));
      g.add(mesh(SPHERE(), toon(0x2d7d2d), -0.9, 4.78, 1.43, 0.14, 0.24, 0.06));
      g.add(mesh(SPHERE(), toon(0x2d7d2d), 0.1, 4.78, 1.43, 0.14, 0.24, 0.06));
      g.add(mesh(SPHERE(), toon(0xff8fa3), -0.4, 4.35, 1.45, 0.14, 0.1, 0.08));
      g.add(mesh(CYL(), fur, 1.6, 1.2, 0, 0.2, 2.6, 0.2).rotateZ(0.9));
      break;
    }
    case 'balloons': {
      for (let k = 0; k < 3; k++) {
        const c = [d.c ?? 0xff5a7a, 0xffd93b, 0x7bd389][k];
        const x = (k - 1) * 0.6;
        const y = 3.4 + k * 0.4;
        g.add(mesh(SPHERE(), toon(c), x, y, 0, 0.45, 0.55, 0.45));
        g.add(mesh(CYL(), basic(0x666666), x * 0.5, y / 2, 0, 0.01, y, 0.01).rotateZ(-x * 0.05));
      }
      break;
    }
    case 'banner': {
      const m = signMesh(d.text ?? '', 8, 1.4, '#ff6fa3', '#ffffff');
      g.add(m);
      for (let k = -3; k <= 3; k++) g.add(mesh(CONE(), toon([0xffd93b, 0x4dc3ff, 0x7bd389][(k + 3) % 3]), k * 1.2, -1.1, 0.05, 0.3, 0.6, 0.05).rotateZ(Math.PI));
      break;
    }
    case 'sign': {
      g.add(mesh(CYL(), toon(0x8b5a2b), 0, -0.8, 0, 0.06, 1.6, 0.06));
      const m = signMesh(d.text ?? '', 2.4, 0.7, '#fff3c4', '#5b3a1e');
      m.position.y = 0.2;
      g.add(m);
      break;
    }
    case 'partyhat':
      g.add(mesh(CONE(), toon(0x4dc3ff), 0, 0.4, 0, 0.3, 0.8, 0.3));
      g.add(mesh(SPHERE(), toon(0xffd93b), 0, 0.82, 0, 0.1, 0.1, 0.1));
      break;
    case 'cakestand':
      g.add(mesh(CYL(), toon(0xffffff), 0, 0.05, 0, 1.1, 0.1, 1.1));
      break;
    case 'tableleg':
      g.add(box(0x8a5530, 0.4, 7, 0.4, 0, -3.5, -0.8));
      break;
    case 'rollingpin':
      g.add(mesh(CYL(), toon(0xd9a066), 0, 0, 0, 0.35, 2, 0.35).rotateX(Math.PI / 2));
      g.add(box(0x8b5a2b, 0.2, 8, 0.2, 0, -4.4, 0));
      break;
    // --- bedroom
    case 'lamp':
      g.add(mesh(CYL(), toon(0x444444), 0, 0.05, 0, 0.5, 0.1, 0.5));
      g.add(mesh(CYL(), toon(0x444444), 0, 1.1, 0, 0.06, 2.1, 0.06));
      g.add(mesh(CONE(), toonUnique(0xffe08a, { emissive: 0x554400 }), 0, 2.3, 0, 0.7, 0.8, 0.7));
      break;
    case 'pencils':
      g.add(mesh(CYL(), toon(0x4dc3ff), 0, 0.4, 0, 0.3, 0.8, 0.3));
      for (let k = 0; k < 3; k++) g.add(mesh(CYL(), toon([0xffd93b, 0xff5a5a, 0x7bd389][k]), (k - 1) * 0.12, 1.1, 0, 0.05, 1, 0.05).rotateZ((k - 1) * 0.15));
      break;
    case 'poster': {
      const m = signMesh(d.text ?? '★', 2.6, 3.4, '#ffd93b', '#e4572e');
      g.add(m);
      break;
    }
    case 'globe':
      g.add(mesh(SPHERE(), toon(0x4dc3ff), 0, 1.2, 0, 0.6, 0.6, 0.6));
      g.add(mesh(CYL(), toon(0x8b5a2b), 0, 0.3, 0, 0.35, 0.6, 0.35));
      break;
    case 'teddy': {
      const c = toon(0xb07d4f);
      g.add(mesh(SPHERE(), c, 0, 0.7, 0, 0.6, 0.7, 0.5));
      g.add(mesh(SPHERE(), c, 0, 1.6, 0, 0.45, 0.45, 0.42));
      g.add(mesh(SPHERE(), c, -0.35, 1.95, 0, 0.16, 0.16, 0.12));
      g.add(mesh(SPHERE(), c, 0.35, 1.95, 0, 0.16, 0.16, 0.12));
      g.add(mesh(SPHERE(), toon(0x222222), -0.14, 1.65, 0.4, 0.05, 0.05, 0.05));
      g.add(mesh(SPHERE(), toon(0x222222), 0.14, 1.65, 0.4, 0.05, 0.05, 0.05));
      break;
    }
    case 'track':
      g.add(box(0x555555, 12, 0.03, 1.2, 0, 0.015, 0));
      for (let x = -5.5; x <= 5.5; x += 1) g.add(box(0xffffff, 0.5, 0.035, 0.08, x, 0.02, 0));
      break;
    case 'headboard':
      g.add(box(0xffb3c7, 0.4, 2.2, 3.4, -0.25, 1.1, -1.4));
      break;
    case 'doghead': {
      const c = toon(0xc58f5a);
      g.add(mesh(SPHERE(), c, 0, 1.0, 0, 0.9, 0.8, 0.8));
      g.add(mesh(SPHERE(), c, 0.8, 0.8, 0, 0.55, 0.4, 0.45));
      g.add(mesh(SPHERE(), toon(0x222222), 1.3, 0.85, 0, 0.14, 0.12, 0.14));
      g.add(mesh(SPHERE(), toon(0x8a5a3a), -0.3, 1.2, 0.6, 0.35, 0.7, 0.15).rotateZ(0.4));
      g.add(box(0x222222, 0.25, 0.04, 0.02, 0.2, 1.2, 0.8));
      break;
    }
    case 'fan': {
      g.add(mesh(CYL(), toon(0xeeeeee), 0, 0.1, 0, 0.8, 0.2, 0.8));
      g.add(mesh(CYL(), toon(0xeeeeee), 0, 1.4, 0, 0.1, 2.6, 0.1));
      g.add(mesh(geo('torus', () => new THREE.TorusGeometry(1, 0.35, 8, 20)), toon(0xdddddd), 0, 2.8, 0, 1.3, 1.3, 0.1).rotateY(Math.PI / 2));
      const blades = new THREE.Group();
      blades.name = 'spin';
      blades.position.set(0, 2.8, 0);
      for (let k = 0; k < 3; k++) {
        const b = mesh(SPHERE(), toon(0x4dc3ff), 0, 0.55, 0, 0.3, 0.6, 0.05);
        const p = new THREE.Group();
        p.rotation.x = (k * Math.PI * 2) / 3;
        p.add(b);
        blades.add(p);
      }
      blades.rotation.y = Math.PI / 2;
      g.add(blades);
      break;
    }
    case 'toyrobot':
      g.add(box(0x9aa5b1, 0.8, 0.9, 0.6, 0, 0.45, 0));
      g.add(box(0xb8c3cf, 0.6, 0.5, 0.5, 0, 1.15, 0));
      g.add(mesh(SPHERE(), toonUnique(0xff5a5a, { emissive: 0x550000 }), 0, 1.5, 0, 0.08, 0.08, 0.08));
      break;
    case 'shelfleg':
      g.add(box(0xb07d4f, 0.15, 0.82, 0.15, 0, 0.41, 0));
      g.add(box(0xb07d4f, 0.15, 0.82, 0.15, 0, 0.41, -1.1));
      break;
    case 'shelfback':
      g.add(box(0xd9b27c, 10, 6, 0.2, 0, 2.5, -0.8));
      break;
    case 'aquarium':
      g.add(box(0x8b5a2b, 2.6, 0.3, 1.4, 0, 0.15, 0));
      g.add(mesh(BOX(), toon(0x8fd3ff, { opacity: 0.35 }), 0, 1.3, 0, 2.4, 2, 1.2));
      g.add(box(0xe6d3a3, 2.3, 0.25, 1.1, 0, 0.45, 0));
      for (let k = 0; k < 3; k++) g.add(mesh(SPHERE(), toon([0xffa53b, 0xff5a7a, 0xffd93b][k]), (k - 1) * 0.6, 1.1 + k * 0.3, 0, 0.18, 0.12, 0.08));
      break;
    case 'fishsign':
      g.add(signMesh(d.text ?? '', 3, 0.9, '#4dc3ff', '#ffffff'));
      break;
    // --- playground
    case 'tree':
      g.add(mesh(CYL(), toon(0x8b5a2b), 0, 2.5, 0, 0.5, 5, 0.5));
      g.add(mesh(SPHERE(), toon(0x4f9e3a), 0, 6, 0, 2.8, 2.4, 2.4));
      g.add(mesh(SPHERE(), toon(0x5fb548), 1.4, 6.8, 0.5, 1.8, 1.6, 1.6));
      g.add(mesh(SPHERE(), toon(0x5fb548), -1.6, 5.8, 0.5, 1.6, 1.4, 1.5));
      break;
    case 'fence':
      for (let x = -6; x <= 6; x += 1) g.add(box(0xf5f0e6, 0.25, 1.6, 0.1, x, 0.8, 0));
      g.add(box(0xf5f0e6, 13, 0.18, 0.08, 0, 1.1, 0.06));
      break;
    case 'slideframe':
      g.add(box(0x4dc3ff, 0.18, d.s ? 1 : 3, 0.18, 0, 0, 0));
      break;
    case 'spade':
      g.add(mesh(CYL(), toon(0x4dc3ff), 0, 0.6, 0, 0.06, 1.2, 0.06).rotateZ(0.4));
      g.add(box(0x4dc3ff, 0.4, 0.5, 0.05, 0.3, 0.1, 0));
      break;
    case 'swingframe':
      g.add(box(0xe4572e, 13, 0.3, 0.3, 0, 5.8, -1.3));
      g.add(box(0xe4572e, 0.3, 8.6, 0.3, -6.4, 1.5, -1.3).rotateZ(0.08));
      g.add(box(0xe4572e, 0.3, 8.6, 0.3, 6.4, 1.5, -1.3).rotateZ(-0.08));
      break;
    case 'goalpost':
      g.add(box(0xffffff, 0.15, 2.4, 0.15, -1, 1.2, 0));
      g.add(box(0xffffff, 0.15, 2.4, 0.15, 1, 1.2, 0));
      g.add(box(0xffffff, 2.15, 0.15, 0.15, 0, 2.4, 0));
      break;
    case 'frame':
      for (const x of [-5.5, -1.5, 1.5, 5.5]) g.add(box(0x4dc3ff, 0.2, 3.2, 0.2, x, 1.6, -0.8));
      g.add(box(0xffd93b, 11, 0.12, 0.12, 0, 3.4, -0.8));
      break;
    case 'benchlegs':
      g.add(box(0x555555, 0.2, 1, 0.8, -3, 0.5, 0));
      g.add(box(0x555555, 0.2, 1, 0.8, 3, 0.5, 0));
      break;
    case 'seesawbase':
      g.add(mesh(CONE(), toon(0xe4572e), 0, 0.6, 0, 0.6, 1.2, 0.6));
      break;
    case 'grandma': {
      g.add(mesh(SPHERE(), toon(0x9b6fb5), 0, 0.9, 0, 0.8, 1, 0.7));
      g.add(mesh(SPHERE(), toon(0xf1c9a5), 0, 2.2, 0, 0.5, 0.55, 0.5));
      g.add(mesh(SPHERE(), toon(0xe8e8e8), 0, 2.65, -0.1, 0.45, 0.35, 0.45));
      g.add(mesh(SPHERE(), toon(0xe8e8e8), 0, 2.95, -0.1, 0.25, 0.22, 0.25));
      g.add(mesh(geo('torus', () => new THREE.TorusGeometry(1, 0.35, 8, 20)), toon(0x333333), -0.18, 2.25, 0.45, 0.12, 0.12, 0.05));
      g.add(mesh(geo('torus', () => new THREE.TorusGeometry(1, 0.35, 8, 20)), toon(0x333333), 0.18, 2.25, 0.45, 0.12, 0.12, 0.05));
      g.add(mesh(SPHERE(), toon(0xff8fa3), 0, 2.02, 0.45, 0.12, 0.05, 0.05));
      break;
    }
    default:
      break;
  }
  return g;
}

export interface WorldView {
  root: THREE.Group;
  update(s: Snapshot, t: number, dt: number): void;
  dispose(): void;
}

export function buildWorld(course: CourseDef, scene: THREE.Scene): WorldView {
  const root = new THREE.Group();
  root.name = 'world';
  const W = course.bounds.maxX;

  // Backdrop
  const floorY = course.bounds.minY + 1;
  const back = new THREE.Group();
  if (course.biome === 'kitchen') {
    back.add(box(0xfbe7c6, W + 60, 30, 0.2, W / 2, floorY + 14, -4.4));
    // tile band behind the counters
    const tiles = new THREE.Mesh(new THREE.PlaneGeometry(W + 60, 3), new THREE.MeshBasicMaterial({ map: tileTexture('#ffffff', '#d8ecf2'), color: 0xffffff }));
    (tiles.material as THREE.MeshBasicMaterial).map!.repeat.set((W + 60) / 1.5, 2);
    tiles.position.set(W / 2, 1.5, -4.28);
    back.add(tiles);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(W + 60, 12), new THREE.MeshBasicMaterial({ map: tileTexture('#e9dcc4', '#d9c7a6') }));
    (floor.material as THREE.MeshBasicMaterial).map!.repeat.set((W + 60) / 2, 6);
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(W / 2, floorY, -2);
    back.add(floor);
    scene.background = new THREE.Color(0xfbe7c6);
  } else if (course.biome === 'bedroom') {
    const wall = new THREE.Mesh(new THREE.PlaneGeometry(W + 60, 30), new THREE.MeshBasicMaterial({ map: stripeTexture('#cfe3ff', '#bcd6fb') }));
    (wall.material as THREE.MeshBasicMaterial).map!.repeat.set((W + 60) / 3, 1);
    wall.position.set(W / 2, floorY + 14, -4.4);
    back.add(wall);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(W + 60, 12), toon(0xb98a5e));
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(W / 2, floorY, -2);
    back.add(floor);
    back.add(box(0xff8fa3, W + 60, 0.05, 6, W / 2, floorY + 0.03, 0));
    scene.background = new THREE.Color(0xcfe3ff);
  } else {
    scene.background = new THREE.Color(0x9fd8ff);
    const grass = new THREE.Mesh(new THREE.PlaneGeometry(W + 80, 40), toon(0x7ccf5a));
    grass.rotation.x = -Math.PI / 2;
    grass.position.set(W / 2, floorY + 2.7, -20);
    back.add(grass);
    for (let k = 0; k < W / 10 + 4; k++) {
      const hill = mesh(SPHERE(), toon(k % 2 ? 0x6cbf4f : 0x62b046), -10 + k * 11, floorY + 2, -26 - hash(k) * 6, 9, 3 + hash(k + 1) * 3, 4);
      back.add(hill);
    }
    for (let k = 0; k < W / 14 + 3; k++) {
      const c = new THREE.Group();
      for (let j = 0; j < 3; j++) c.add(mesh(SPHERE(), toon(0xffffff), j * 1.2, hash(k * 3 + j) * 0.5, 0, 1.2, 0.8, 0.6));
      c.position.set(-5 + k * 14 + hash(k) * 5, 9 + hash(k + 7) * 4, -18);
      c.name = 'cloud';
      back.add(c);
    }
    back.add(mesh(SPHERE(), basic(0xfff3a0), W * 0.7, 16, -30, 2.5, 2.5, 0.5));
  }
  root.add(back);

  // Static scenery is merged into one mesh per material: hundreds of draw calls become a few dozen.
  const statics = new THREE.Group();
  course.solids.forEach((s, i) => {
    const m = solidMesh(s, i);
    if (m) statics.add(m);
  });
  const spinners: THREE.Object3D[] = [];
  const clouds: THREE.Object3D[] = [];
  for (const d of course.decor) {
    const m = decorMesh(d);
    let spins = false;
    m.traverse((o) => {
      if (o.name === 'spin') {
        spinners.push(o);
        spins = true;
      }
    });
    (spins ? root : statics).add(m);
  }
  root.add(mergeStatic(statics));
  back.traverse((o) => {
    if (o.name === 'cloud') clouds.push(o);
  });

  // Zones: burners glow, taps pour, puddles shimmer.
  const zoneViews: { i: number; obj: THREE.Object3D; kind: string; mat?: THREE.MeshToonMaterial }[] = [];
  course.zones.forEach((z, i) => {
    if (z.tag === 'burner') {
      const mat = toonUnique(0x444444, { emissive: 0x000000 });
      const ring = mesh(geo('ring', () => new THREE.TorusGeometry(1, 0.12, 6, 24)), mat, z.x, z.y - z.h / 2 + 0.02, -0.2, z.w * 0.4, z.w * 0.4, z.w * 0.4);
      ring.rotation.x = Math.PI / 2;
      root.add(ring);
      const ring2 = mesh(geo('ring', () => new THREE.TorusGeometry(1, 0.12, 6, 24)), mat, z.x, z.y - z.h / 2 + 0.02, -0.2, z.w * 0.22, z.w * 0.22, z.w * 0.22);
      ring2.rotation.x = Math.PI / 2;
      root.add(ring2);
      zoneViews.push({ i, obj: ring, kind: 'burner', mat });
    } else if (z.tag === 'tap') {
      const stream = mesh(CYL(), toonUnique(0x7fd0ff, { opacity: 0.6 }), z.x, z.y + 0.3, 0, z.w * 0.35, z.h, z.w * 0.35);
      root.add(stream);
      zoneViews.push({ i, obj: stream, kind: 'tap' });
    } else if (z.kind === 'kill' && z.tag !== 'floor') {
      const water = mesh(BOX(), toon(z.tag === 'puddle' ? 0x7a6a4f : 0x7fd0ff, { opacity: 0.8 }), z.x, z.y + z.h / 2 - 0.1, -0.4, z.w, 0.2, 2.6);
      root.add(water);
    }
  });

  // Movers
  const moverViews = course.movers.map((m) => {
    const g = new THREE.Group();
    if (m.kind === 'paw') {
      g.add(new THREE.Mesh(rbox(m.w, m.h, 0.9, 0.3), toon(0xf0a04b)));
      for (let k = -1; k <= 1; k++) g.add(mesh(SPHERE(), toon(0xff8fa3), -m.w / 2 + 0.05, k * 0.2, 0.2, 0.08, 0.1, 0.1));
      g.add(mesh(CYL(), toon(0xf0a04b), m.w / 2 + 1.5, 0.2, 0, 0.3, 3, 0.3).rotateZ(Math.PI / 2 - 0.3));
    } else if (m.kind === 'car') {
      g.add(new THREE.Mesh(rbox(m.w, m.h * 0.6, 0.9, 0.12), toon(0xff3b3b)));
      g.add(mesh(BOX(), toon(0xbfe6ff), -0.1, m.h * 0.35, 0, m.w * 0.5, m.h * 0.35, 0.8));
      for (const x of [-m.w / 3, m.w / 3]) g.add(mesh(CYL(), toon(0x222222), x, -m.h * 0.3, 0.45, 0.2, 0.1, 0.2).rotateX(Math.PI / 2));
    } else if (m.kind === 'swing') {
      g.add(new THREE.Mesh(rbox(m.w, m.h, 1, 0.08), toon(0x333333)));
      const p = m.path.type === 'pendulum' ? m.path.len : 5;
      g.add(mesh(CYL(), toon(0x999999), -m.w / 2 + 0.1, p / 2, 0, 0.03, p, 0.03));
      g.add(mesh(CYL(), toon(0x999999), m.w / 2 - 0.1, p / 2, 0, 0.03, p, 0.03));
    } else if (m.kind === 'dog') {
      g.add(mesh(SPHERE(), toon(0xc58f5a), 0, 0, 0, m.w / 2, m.h / 2 + 0.05, 1.1));
      g.add(mesh(SPHERE(), toon(0x8a5a3a), -0.6, 0.3, 0.9, 0.7, 0.35, 0.3));
    } else {
      g.add(new THREE.Mesh(rbox(m.w, m.h, 1, 0.05), toon(0x888888)));
    }
    root.add(g);
    return g;
  });

  // Props
  const propViews = course.props.map((p, i) => {
    let o: THREE.Object3D;
    if (p.kind === 'ball') {
      const g = new THREE.Group();
      g.add(mesh(geo('ico', () => new THREE.IcosahedronGeometry(1, 1)), toon(0xffffff), 0, 0, 0, p.w / 2, p.w / 2, p.w / 2));
      for (let k = 0; k < 6; k++) {
        const a = (k / 6) * Math.PI * 2;
        g.add(mesh(SPHERE(), toon(0x222222), Math.cos(a) * p.w * 0.35, Math.sin(a) * p.w * 0.35, p.w * 0.3, 0.1, 0.1, 0.05));
      }
      o = g;
    } else if (p.kind === 'pillow') o = new THREE.Mesh(rbox(p.w, p.h, 1.4, 0.35), toon(0xfdfdff));
    else if (p.kind === 'seesaw') o = new THREE.Mesh(rbox(p.w, p.h, 1.2, 0.06), toon(p.mat === 'board' ? 0xd6a15c : 0xffca3a));
    else o = new THREE.Mesh(rbox(p.w, p.h, p.w, 0.05), toon(p.mat === 'sugar' ? 0xffffff : BLOCK_COLORS[i % BLOCK_COLORS.length]));
    root.add(o);
    return o;
  });

  // Collectibles: golden stars
  const starShape = new THREE.Shape();
  for (let k = 0; k < 10; k++) {
    const r = k % 2 ? 0.14 : 0.32;
    const a = (k / 10) * Math.PI * 2 + Math.PI / 2;
    if (k === 0) starShape.moveTo(Math.cos(a) * r, Math.sin(a) * r);
    else starShape.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  const starGeo = geo('star', () => new THREE.ExtrudeGeometry(starShape, { depth: 0.1, bevelEnabled: true, bevelSize: 0.03, bevelThickness: 0.03, bevelSegments: 1 }));
  const coinMat = toonUnique(0xffd23b, { emissive: 0x664400 });
  const coins = course.collectibles.map((c) => {
    const m = new THREE.Mesh(starGeo, coinMat);
    m.position.set(c.x, c.y, 0);
    root.add(m);
    return m;
  });

  // Checkpoint flags
  const flags = course.checkpoints.map((c, i) => {
    const g = new THREE.Group();
    g.position.set(c.x, c.y, -0.9);
    if (i === 0) return g;
    g.add(mesh(CYL(), toon(0xffffff), 0, 0.9, 0, 0.04, 1.8, 0.04));
    const flag = new THREE.Mesh(geo('flag', () => {
      const s = new THREE.Shape();
      s.moveTo(0, 0);
      s.lineTo(0.7, -0.22);
      s.lineTo(0, -0.44);
      return new THREE.ShapeGeometry(s);
    }), new THREE.MeshBasicMaterial({ color: 0xbbbbbb, side: THREE.DoubleSide }));
    flag.position.set(0.02, 1.78, 0);
    flag.name = 'flag';
    g.add(flag);
    root.add(g);
    return g;
  });

  // Goal marker
  const goal = new THREE.Group();
  goal.position.set(course.goal.x, course.goal.y - course.goal.h / 2, 0);
  const goalMat = new THREE.MeshBasicMaterial({ color: 0x7bff9a, transparent: true, opacity: 0.35, depthWrite: false });
  const pad = new THREE.Mesh(new THREE.BoxGeometry(course.goal.w, 0.06, 1.6), goalMat);
  pad.position.y = 0.04;
  goal.add(pad);
  const arrow = mesh(CONE(), toonUnique(0x3ddc84, { emissive: 0x0a4020 }), 0, 3, 0, 0.35, 0.6, 0.35);
  arrow.rotation.z = Math.PI;
  goal.add(arrow);
  root.add(goal);

  scene.add(root);

  return {
    root,
    update(s, t) {
      zoneViews.forEach((z) => {
        const on = !!(s.zonesOn & (1 << z.i));
        if (z.kind === 'burner' && z.mat) {
          z.mat.color.setHex(on ? 0xff5a1f : 0x444444);
          z.mat.emissive.setHex(on ? 0xaa2200 : 0x000000);
        } else if (z.kind === 'tap') z.obj.visible = on;
      });
      moverViews.forEach((g, i) => {
        g.position.set(s.movers[i * 3], s.movers[i * 3 + 1], 0);
        g.rotation.z = s.movers[i * 3 + 2];
      });
      propViews.forEach((o, i) => {
        o.position.set(s.props[i * 3], s.props[i * 3 + 1], 0);
        o.rotation.z = s.props[i * 3 + 2];
      });
      const got = new Set(s.collected);
      coins.forEach((m, i) => {
        m.visible = !got.has(i);
        m.rotation.y = t * 2.2 + i;
        m.position.y = course.collectibles[i].y + Math.sin(t * 3 + i) * 0.08;
      });
      flags.forEach((f, i) => {
        const flag = f.getObjectByName('flag') as THREE.Mesh | undefined;
        if (flag) (flag.material as THREE.MeshBasicMaterial).color.setHex(i <= s.cp ? 0x3ddc84 : 0xff5a5a);
      });
      arrow.position.y = 3 + Math.sin(t * 4) * 0.25;
      goalMat.opacity = 0.25 + 0.15 * Math.sin(t * 5);
      spinners.forEach((o) => (o.rotation.x = t * 12));
      clouds.forEach((c, i) => (c.position.x += 0.004 * (1 + (i % 3))));
    },
    dispose() {
      scene.remove(root);
      root.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.userData.owned) m.geometry.dispose();
        if (m.material && !Array.isArray(m.material) && (m.material as THREE.MeshBasicMaterial).map) (m.material as THREE.MeshBasicMaterial).map!.dispose();
      });
    },
  };
}

function mergeStatic(src: THREE.Object3D): THREE.Group {
  src.updateMatrixWorld(true);
  const buckets = new Map<THREE.Material, THREE.BufferGeometry[]>();
  const keep: THREE.Mesh[] = [];
  src.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const mat = m.material as THREE.Material & { map?: THREE.Texture | null };
    if (Array.isArray(m.material) || mat.map || mat.transparent) {
      keep.push(m);
      return;
    }
    let g = m.geometry.clone().applyMatrix4(m.matrixWorld);
    for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal') g.deleteAttribute(name);
    if (g.index) g = g.toNonIndexed();
    let list = buckets.get(mat);
    if (!list) buckets.set(mat, (list = []));
    list.push(g);
  });
  const out = new THREE.Group();
  for (const [mat, list] of buckets) {
    const merged = mergeGeometries(list);
    list.forEach((g) => g.dispose());
    if (merged) {
      const mesh = new THREE.Mesh(merged, mat);
      mesh.userData.owned = true;
      out.add(mesh);
    }
  }
  for (const k of keep) out.attach(k);
  return out;
}

function tileTexture(a: string, b: string) {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  g.fillStyle = a;
  g.fillRect(0, 0, 64, 64);
  g.fillStyle = b;
  g.fillRect(0, 0, 32, 32);
  g.fillRect(32, 32, 32, 32);
  g.strokeStyle = 'rgba(0,0,0,0.08)';
  g.strokeRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function stripeTexture(a: string, b: string) {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 8;
  const g = c.getContext('2d')!;
  g.fillStyle = a;
  g.fillRect(0, 0, 64, 8);
  g.fillStyle = b;
  g.fillRect(0, 0, 24, 8);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
