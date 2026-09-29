// All sound is synthesized with WebAudio: no downloads, tiny footprint, and every voice line is
// cheerful gibberish so it works in any language.

let ctx: AudioContext | null = null;
let master: GainNode;
let sfxBus: GainNode;
let musicBus: GainNode;
let noiseBuf: AudioBuffer;
let musicOn = true;
let sfxOn = true;
let musicTimer: number | null = null;

function ac(): AudioContext | null {
  if (ctx) return ctx;
  const C = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!C) return null;
  ctx = new C();
  master = ctx.createGain();
  master.gain.value = 0.7;
  master.connect(ctx.destination);
  sfxBus = ctx.createGain();
  sfxBus.connect(master);
  musicBus = ctx.createGain();
  musicBus.gain.value = 0.22;
  musicBus.connect(master);
  noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return ctx;
}

/** Must be called from a user gesture (browsers block audio until then). */
export function unlockAudio() {
  const c = ac();
  if (c && c.state === 'suspended') void c.resume();
  if (musicOn && musicTimer === null) startMusic();
}

export function setAudio(opts: { music?: boolean; sfx?: boolean }) {
  if (opts.sfx !== undefined) sfxOn = opts.sfx;
  if (opts.music !== undefined) {
    musicOn = opts.music;
    if (!musicOn) stopMusic();
    else if (ctx) startMusic();
  }
}

function env(g: GainNode, t: number, a: number, peak: number, d: number) {
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + a);
  g.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
}

function tone(type: OscillatorType, f0: number, f1: number, dur: number, vol = 0.3, delay = 0, pan = 0) {
  const c = ac();
  if (!c || !sfxOn) return;
  const t = c.currentTime + delay;
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(f0, t);
  o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
  env(g, t, 0.005, vol, dur);
  const p = c.createStereoPanner();
  p.pan.value = pan;
  o.connect(g).connect(p).connect(sfxBus);
  o.start(t);
  o.stop(t + dur + 0.05);
}

function noise(dur: number, filter: BiquadFilterType, freq: number, vol = 0.3, delay = 0, q = 1) {
  const c = ac();
  if (!c || !sfxOn) return;
  const t = c.currentTime + delay;
  const s = c.createBufferSource();
  s.buffer = noiseBuf;
  const f = c.createBiquadFilter();
  f.type = filter;
  f.frequency.value = freq;
  f.Q.value = q;
  const g = c.createGain();
  env(g, t, 0.005, vol, dur);
  s.connect(f).connect(g).connect(sfxBus);
  s.start(t, Math.random() * 0.5);
  s.stop(t + dur + 0.05);
}

const VOWELS = [
  [730, 1090],
  [270, 2290],
  [300, 870],
  [530, 1840],
  [640, 1190],
];

/** Gibberish "voice line": formant-filtered blips at the character's own pitch. */
export function voice(text: string, pitch = 1) {
  const c = ac();
  if (!c || !sfxOn) return;
  const syll = Math.max(2, Math.min(7, Math.round(text.length / 3)));
  let t = c.currentTime;
  const base = 190 * pitch;
  for (let i = 0; i < syll; i++) {
    const dur = 0.07 + Math.random() * 0.06;
    const o = c.createOscillator();
    o.type = 'sawtooth';
    const f = base * (1 + (Math.random() - 0.3) * 0.35) * (i === syll - 1 && text.endsWith('!') ? 1.3 : 1);
    o.frequency.setValueAtTime(f, t);
    o.frequency.linearRampToValueAtTime(f * (0.85 + Math.random() * 0.3), t + dur);
    const [f1, f2] = VOWELS[Math.floor(Math.random() * VOWELS.length)];
    const b1 = c.createBiquadFilter();
    b1.type = 'bandpass';
    b1.frequency.value = f1 * (0.9 + pitch * 0.2);
    b1.Q.value = 5;
    const b2 = c.createBiquadFilter();
    b2.type = 'bandpass';
    b2.frequency.value = f2 * (0.9 + pitch * 0.2);
    b2.Q.value = 7;
    const g = c.createGain();
    env(g, t, 0.01, 0.55, dur);
    o.connect(b1).connect(g);
    o.connect(b2).connect(g);
    g.connect(sfxBus);
    o.start(t);
    o.stop(t + dur + 0.05);
    t += dur + 0.02;
  }
}

export type Sfx =
  | 'jump'
  | 'land'
  | 'grab'
  | 'release'
  | 'dive'
  | 'ouch'
  | 'sizzle'
  | 'splash'
  | 'crunch'
  | 'checkpoint'
  | 'collect'
  | 'delivered'
  | 'drop'
  | 'panic'
  | 'kick'
  | 'pop'
  | 'click'
  | 'star'
  | 'meow';

export function sfx(name: Sfx, pan = 0) {
  switch (name) {
    case 'jump':
      tone('sine', 260, 620, 0.16, 0.18, 0, pan);
      break;
    case 'land':
      noise(0.08, 'lowpass', 400, 0.3);
      break;
    case 'grab':
      tone('square', 900, 500, 0.04, 0.08, 0, pan);
      break;
    case 'release':
      tone('triangle', 500, 300, 0.05, 0.06, 0, pan);
      break;
    case 'dive':
      noise(0.25, 'bandpass', 1200, 0.25, 0, 0.8);
      break;
    case 'ouch':
      tone('square', 700, 180, 0.22, 0.12, 0, pan);
      break;
    case 'sizzle':
      noise(0.5, 'highpass', 3000, 0.18);
      break;
    case 'splash':
      noise(0.35, 'bandpass', 900, 0.35, 0, 0.6);
      tone('sine', 400, 900, 0.1, 0.1);
      break;
    case 'crunch':
      noise(0.12, 'bandpass', 1800, 0.4, 0, 2);
      noise(0.1, 'lowpass', 300, 0.3, 0.03);
      break;
    case 'checkpoint':
      [523, 659, 784, 1047].forEach((f, i) => tone('triangle', f, f, 0.14, 0.18, i * 0.08));
      break;
    case 'collect':
      tone('sine', 1320, 1320, 0.08, 0.15);
      tone('sine', 1760, 1760, 0.14, 0.15, 0.07);
      break;
    case 'star':
      tone('triangle', 880, 1760, 0.25, 0.2);
      break;
    case 'delivered':
      [523, 659, 784, 1047, 784, 1047].forEach((f, i) => tone('square', f, f, 0.16, 0.1, i * 0.12));
      [262, 330, 392].forEach((f) => tone('triangle', f, f, 0.8, 0.12, 0.6));
      break;
    case 'drop':
      [392, 370, 349, 330].forEach((f, i) => tone('sawtooth', f, f * (i === 3 ? 0.8 : 1), i === 3 ? 0.6 : 0.22, 0.1, i * 0.25));
      break;
    case 'panic':
      tone('square', 800, 1200, 0.08, 0.1);
      tone('square', 800, 1200, 0.08, 0.1, 0.1);
      break;
    case 'kick':
      tone('sine', 150, 60, 0.12, 0.35);
      break;
    case 'pop':
      tone('sine', 600, 1200, 0.06, 0.15);
      break;
    case 'click':
      tone('triangle', 1200, 900, 0.03, 0.08);
      break;
    case 'meow': {
      const c = ac();
      if (!c || !sfxOn) break;
      tone('sawtooth', 500, 800, 0.15, 0.08);
      tone('sawtooth', 800, 450, 0.3, 0.08, 0.15);
      break;
    }
  }
}

// ---------------------------------------------------------------- music: a tiny bouncy loop

const SCALE = [0, 2, 4, 7, 9, 12, 14, 16];
function startMusic() {
  const c = ac();
  if (!c || musicTimer !== null) return;
  let step = 0;
  let next = c.currentTime + 0.1;
  const bpm = 112;
  const spb = 60 / bpm / 2;
  const melody = [0, 2, 4, 2, 5, 4, 2, 0, 0, 2, 4, 5, 7, 5, 4, 2];
  const bass = [0, 0, 5, 5, 3, 3, 4, 4];
  const note = (semi: number, t: number, type: OscillatorType, vol: number, dur: number, base: number) => {
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type;
    o.frequency.value = base * Math.pow(2, semi / 12);
    env(g, t, 0.01, vol, dur);
    o.connect(g).connect(musicBus);
    o.start(t);
    o.stop(t + dur + 0.05);
  };
  const tick = () => {
    while (next < c.currentTime + 0.3) {
      const bar = Math.floor(step / 16) % 4;
      if (step % 2 === 0) note(SCALE[melody[step % 16]] + (bar === 3 ? 2 : 0), next, 'triangle', 0.12, spb * 1.6, 392);
      if (step % 4 === 0) note([0, 5, 7, 5][bar] + bass[(step / 4) % 8] * 0, next, 'sine', 0.22, spb * 3, 98);
      if (step % 4 === 2) {
        const s = c.createBufferSource();
        s.buffer = noiseBuf;
        const f = c.createBiquadFilter();
        f.type = 'highpass';
        f.frequency.value = 6000;
        const g = c.createGain();
        env(g, next, 0.002, 0.05, 0.04);
        s.connect(f).connect(g).connect(musicBus);
        s.start(next, Math.random() * 0.5);
        s.stop(next + 0.06);
      }
      next += spb;
      step++;
    }
  };
  musicTimer = window.setInterval(tick, 100);
}

function stopMusic() {
  if (musicTimer !== null) clearInterval(musicTimer);
  musicTimer = null;
}
