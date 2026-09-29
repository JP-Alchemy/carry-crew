import * as THREE from 'three';
import type { Look } from '../shared/types';
import { CharacterView, RopeView } from './render/actors';
import { toon } from './render/materials';

/** Small turntable preview of your character and rope. */
export class Wardrobe {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(30, 1, 0.1, 50);
  private char: CharacterView | null = null;
  private rope = new RopeView(20);
  private raf = 0;
  private canvas: HTMLCanvasElement;
  private look: Look | null = null;

  constructor(host: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'preview';
    host.appendChild(this.canvas);
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(2, devicePixelRatio));
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0xb0a090, 1.8));
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(-2, 4, 5);
    this.scene.add(sun);
    const floor = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 1.2, 0.1, 32), toon(0xf6f1e7));
    floor.position.y = -0.41;
    this.scene.add(floor, this.rope.mesh);
    this.camera.position.set(0, 0.5, 4.2);
    this.camera.lookAt(0, 0.1, 0);
    const loop = (t: number) => {
      this.raf = requestAnimationFrame(loop);
      const w = this.canvas.clientWidth;
      const h = this.canvas.clientHeight;
      if (this.canvas.width !== Math.floor(w * this.renderer.getPixelRatio())) {
        this.renderer.setSize(w, h, false);
        this.camera.aspect = w / h;
        this.camera.updateProjectionMatrix();
      }
      if (this.char) {
        const s = t / 1000;
        const f = Math.sin(s * 0.8) > 0 ? 1 : -1;
        this.char.update({ x: 0, y: 0, vx: Math.sin(s * 2) * 0.5, vy: 0, f, g: 1, st: 1, s: 0, pu: 0 }, 1 / 60, s);
        const pts: number[] = [];
        for (let k = 0; k <= 8; k++) pts.push(0.3 + k * 0.25, -0.05 - Math.sin((k / 8) * Math.PI) * 0.25 + Math.sin(s * 3 + k) * 0.02);
        this.rope.update([{ pts, style: this.look!.rope }]);
      }
      this.renderer.render(this.scene, this.camera);
    };
    this.raf = requestAnimationFrame(loop);
  }

  setLook(look: Look) {
    this.look = { ...look };
    if (!this.char) {
      this.char = new CharacterView(this.look);
      this.scene.add(this.char.group);
    } else this.char.setLook(this.look);
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.canvas.remove();
  }
}
