import type { Snapshot } from '../shared/types';
import type { GameRenderer } from './render/renderer';

// Clip saving: we keep the last 15 seconds of game states (not video), and on request replay them
// through the renderer while recording the canvas, with the game's name burned in.

const SECONDS = 15;
const FPS = 30;

export class ClipBuffer {
  private frames: Snapshot[] = [];
  private acc = 0;

  push(s: Snapshot, dt: number) {
    this.acc += dt;
    // Events must never be dropped from the replay, so merge them into the next kept frame.
    if (this.acc < 1 / FPS) {
      if (s.events.length && this.frames.length) this.frames[this.frames.length - 1].events.push(...s.events);
      return;
    }
    this.acc = 0;
    this.frames.push({ ...s, events: [...s.events] });
    if (this.frames.length > SECONDS * FPS) this.frames.shift();
  }

  clear() {
    this.frames = [];
  }

  get length() {
    return this.frames.length;
  }

  snapshot(): Snapshot[] {
    return this.frames.map((f) => ({ ...f, events: [...f.events] }));
  }
}

export function clipSupported() {
  return typeof MediaRecorder !== 'undefined' && !!HTMLCanvasElement.prototype.captureStream;
}

export async function exportClip(renderer: GameRenderer, frames: Snapshot[], title: string, onProgress?: (u: number) => void): Promise<Blob | null> {
  if (!clipSupported() || !frames.length) return null;
  const src = renderer.canvas;
  const w = Math.min(1280, src.width);
  const h = Math.round((w / src.width) * src.height);
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const g = out.getContext('2d')!;
  const stream = out.captureStream(FPS);
  const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4'].find((m) => MediaRecorder.isTypeSupported(m)) ?? '';
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 4_000_000 } : undefined);
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const done = new Promise<void>((res) => (rec.onstop = () => res()));
  rec.start(250);
  const scale = w / src.clientWidth;
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    renderer.handleEvents(f.events, f);
    renderer.render(f, 1 / FPS, f.t);
    g.drawImage(src, 0, 0, w, h);
    renderer.drawOverlay(g, scale);
    // Watermark
    g.save();
    g.font = `900 ${Math.round(h * 0.05)}px system-ui, sans-serif`;
    g.textAlign = 'right';
    g.textBaseline = 'bottom';
    g.lineWidth = h * 0.008;
    g.strokeStyle = 'rgba(0,0,0,0.55)';
    g.fillStyle = '#ffd23b';
    g.strokeText('CARRY CREW', w - h * 0.03, h - h * 0.03);
    g.fillText('CARRY CREW', w - h * 0.03, h - h * 0.03);
    g.font = `700 ${Math.round(h * 0.025)}px system-ui, sans-serif`;
    g.fillStyle = '#fff';
    g.strokeText(title, w - h * 0.03, h - h * 0.09);
    g.fillText(title, w - h * 0.03, h - h * 0.09);
    g.restore();
    onProgress?.(i / frames.length);
    await new Promise((r) => setTimeout(r, 1000 / FPS));
  }
  rec.stop();
  await done;
  return new Blob(chunks, { type: mime || 'video/webm' });
}

export function download(blob: Blob, name: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 1000);
}
