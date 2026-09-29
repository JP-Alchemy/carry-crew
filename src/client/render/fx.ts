import * as THREE from 'three';

// A small CPU particle system drawn as one Points object: crumbs, splashes, sparkles, confetti, dust.
const MAX = 900;

export class Particles {
  readonly points: THREE.Points;
  private pos = new Float32Array(MAX * 3);
  private col = new Float32Array(MAX * 3);
  private size = new Float32Array(MAX);
  private vel = new Float32Array(MAX * 3);
  private life = new Float32Array(MAX);
  private maxLife = new Float32Array(MAX);
  private grav = new Float32Array(MAX);
  private baseSize = new Float32Array(MAX);
  private next = 0;
  private c = new THREE.Color();

  constructor() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(this.col, 3));
    g.setAttribute('size', new THREE.BufferAttribute(this.size, 1));
    const tex = (() => {
      const cv = document.createElement('canvas');
      cv.width = cv.height = 32;
      const x = cv.getContext('2d')!;
      const grd = x.createRadialGradient(16, 16, 0, 16, 16, 16);
      grd.addColorStop(0, 'rgba(255,255,255,1)');
      grd.addColorStop(0.6, 'rgba(255,255,255,0.9)');
      grd.addColorStop(1, 'rgba(255,255,255,0)');
      x.fillStyle = grd;
      x.fillRect(0, 0, 32, 32);
      return new THREE.CanvasTexture(cv);
    })();
    const m = new THREE.ShaderMaterial({
      uniforms: { map: { value: tex }, scale: { value: 300 } },
      vertexShader: `attribute float size; varying vec3 vColor; uniform float scale;
        void main(){ vColor = color; vec4 mv = modelViewMatrix * vec4(position,1.0); gl_PointSize = size * scale / -mv.z; gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `uniform sampler2D map; varying vec3 vColor;
        void main(){ vec4 t = texture2D(map, gl_PointCoord); if (t.a < 0.05) discard; gl_FragColor = vec4(vColor, t.a); }`,
      transparent: true,
      depthWrite: false,
      vertexColors: true,
    });
    this.points = new THREE.Points(g, m);
    this.points.frustumCulled = false;
  }

  setScale(px: number) {
    (this.points.material as THREE.ShaderMaterial).uniforms.scale.value = px;
  }

  emit(x: number, y: number, n: number, color: number | number[], o: { speed?: number; up?: number; size?: number; life?: number; gravity?: number; spread?: number; z?: number } = {}) {
    for (let k = 0; k < n; k++) {
      const i = this.next;
      this.next = (this.next + 1) % MAX;
      const a = Math.random() * Math.PI * 2;
      const sp = (o.speed ?? 3) * (0.3 + Math.random() * 0.7);
      this.pos[i * 3] = x + (Math.random() - 0.5) * (o.spread ?? 0.2);
      this.pos[i * 3 + 1] = y + (Math.random() - 0.5) * (o.spread ?? 0.2);
      this.pos[i * 3 + 2] = (o.z ?? 0.3) + (Math.random() - 0.5) * 0.4;
      this.vel[i * 3] = Math.cos(a) * sp;
      this.vel[i * 3 + 1] = Math.sin(a) * sp + (o.up ?? 2);
      this.vel[i * 3 + 2] = (Math.random() - 0.5) * sp * 0.5;
      const cc = Array.isArray(color) ? color[Math.floor(Math.random() * color.length)] : color;
      this.c.setHex(cc);
      this.col[i * 3] = this.c.r;
      this.col[i * 3 + 1] = this.c.g;
      this.col[i * 3 + 2] = this.c.b;
      this.life[i] = this.maxLife[i] = (o.life ?? 0.8) * (0.6 + Math.random() * 0.6);
      this.grav[i] = o.gravity ?? -14;
      this.baseSize[i] = (o.size ?? 0.12) * (0.6 + Math.random() * 0.8);
    }
  }

  /** Streaks drifting sideways (wind). */
  wind(x: number, y: number, w: number, h: number, fx: number) {
    const i = this.next;
    this.next = (this.next + 1) % MAX;
    this.pos[i * 3] = x + (Math.random() - 0.5) * w;
    this.pos[i * 3 + 1] = y + (Math.random() - 0.5) * h;
    this.pos[i * 3 + 2] = 0.5;
    this.vel[i * 3] = fx * 0.6;
    this.vel[i * 3 + 1] = (Math.random() - 0.5) * 0.5;
    this.vel[i * 3 + 2] = 0;
    this.col[i * 3] = this.col[i * 3 + 1] = this.col[i * 3 + 2] = 1;
    this.life[i] = this.maxLife[i] = 0.7;
    this.grav[i] = 0;
    this.baseSize[i] = 0.08;
  }

  update(dt: number) {
    for (let i = 0; i < MAX; i++) {
      if (this.life[i] <= 0) {
        this.size[i] = 0;
        continue;
      }
      this.life[i] -= dt;
      this.vel[i * 3 + 1] += this.grav[i] * dt;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      this.size[i] = this.baseSize[i] * Math.min(1, (this.life[i] / this.maxLife[i]) * 2.5);
    }
    const g = this.points.geometry;
    g.attributes.position.needsUpdate = true;
    g.attributes.size.needsUpdate = true;
    g.attributes.color.needsUpdate = true;
  }
}
