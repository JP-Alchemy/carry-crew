import * as THREE from 'three';

// Toy-like cel shading: a 3-step gradient for MeshToonMaterial.
let gradient: THREE.DataTexture | null = null;
function gradientMap() {
  if (!gradient) {
    const data = new Uint8Array([90, 90, 90, 255, 170, 170, 170, 255, 235, 235, 235, 255, 255, 255, 255, 255]);
    gradient = new THREE.DataTexture(data, 4, 1, THREE.RGBAFormat);
    gradient.minFilter = THREE.NearestFilter;
    gradient.magFilter = THREE.NearestFilter;
    gradient.needsUpdate = true;
  }
  return gradient;
}

const cache = new Map<string, THREE.Material>();

export function toon(color: number, opts: { emissive?: number; transparent?: boolean; opacity?: number } = {}): THREE.MeshToonMaterial {
  const key = `t${color}_${opts.emissive ?? 0}_${opts.opacity ?? 1}`;
  let m = cache.get(key) as THREE.MeshToonMaterial | undefined;
  if (!m) {
    m = new THREE.MeshToonMaterial({
      color,
      gradientMap: gradientMap(),
      emissive: opts.emissive ?? 0,
      transparent: opts.transparent ?? (opts.opacity ?? 1) < 1,
      opacity: opts.opacity ?? 1,
    });
    cache.set(key, m);
  }
  return m;
}

/** A material that is not shared (for things we animate: glow, fade). */
export function toonUnique(color: number, opts: { emissive?: number; opacity?: number } = {}) {
  return new THREE.MeshToonMaterial({
    color,
    gradientMap: gradientMap(),
    emissive: opts.emissive ?? 0,
    transparent: (opts.opacity ?? 1) < 1,
    opacity: opts.opacity ?? 1,
  });
}

export function basic(color: number, opacity = 1) {
  const key = `b${color}_${opacity}`;
  let m = cache.get(key) as THREE.MeshBasicMaterial | undefined;
  if (!m) {
    m = new THREE.MeshBasicMaterial({ color, transparent: opacity < 1, opacity, depthWrite: opacity >= 1 });
    cache.set(key, m);
  }
  return m;
}

const geoCache = new Map<string, THREE.BufferGeometry>();
export function geo<T extends THREE.BufferGeometry>(key: string, make: () => T): T {
  let g = geoCache.get(key) as T | undefined;
  if (!g) {
    g = make();
    geoCache.set(key, g);
  }
  return g;
}

/** Free a subtree's GPU resources, leaving the shared cached geometries/materials alone. */
export function disposeTree(root: THREE.Object3D) {
  const cachedMats = new Set(cache.values());
  const cachedGeos = new Set(geoCache.values());
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh && !(o as THREE.Points).isPoints) return;
    if (m.geometry && !cachedGeos.has(m.geometry)) m.geometry.dispose();
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    for (const mat of mats) {
      if (!mat || cachedMats.has(mat)) continue;
      (mat as THREE.MeshBasicMaterial).map?.dispose();
      mat.dispose();
    }
  });
}

export const BOX = () => geo('box', () => new THREE.BoxGeometry(1, 1, 1));
export const SPHERE = () => geo('sphere', () => new THREE.SphereGeometry(1, 16, 12));
export const CYL = () => geo('cyl', () => new THREE.CylinderGeometry(1, 1, 1, 16));
export const CONE = () => geo('cone', () => new THREE.ConeGeometry(1, 1, 16));

export function mesh(g: THREE.BufferGeometry, m: THREE.Material, x = 0, y = 0, z = 0, sx = 1, sy = 1, sz = 1): THREE.Mesh {
  const o = new THREE.Mesh(g, m);
  o.position.set(x, y, z);
  o.scale.set(sx, sy, sz);
  return o;
}

export function box(color: number, w: number, h: number, d: number, x = 0, y = 0, z = 0) {
  return mesh(BOX(), toon(color), x, y, z, w, h, d);
}

export function textTexture(text: string, opts: { color?: string; bg?: string; font?: string; w?: number; h?: number } = {}) {
  const w = opts.w ?? 512;
  const h = opts.h ?? 128;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;
  if (opts.bg) {
    g.fillStyle = opts.bg;
    g.beginPath();
    g.roundRect(4, 4, w - 8, h - 8, 24);
    g.fill();
  }
  g.fillStyle = opts.color ?? '#fff';
  g.font = opts.font ?? `bold ${Math.floor(h * 0.55)}px "Baloo 2", system-ui, sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, w / 2, h / 2 + 4);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
