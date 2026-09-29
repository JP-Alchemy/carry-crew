import { EMOTES, PINGS, type EmoteKind, type PingKind, type PlayerInput } from '../shared/types';

export type Action =
  | { a: 'ping'; kind: PingKind; screen?: { x: number; y: number } }
  | { a: 'emote'; kind: EmoteKind }
  | { a: 'chat' }
  | { a: 'pause' };

export type Layout = 'solo' | 'p1' | 'p2';

interface Keys {
  left: string[];
  right: string[];
  up: string[];
  down: string[];
  jump: string[];
  grab: string[];
  dive: string[];
  upJumps: boolean; // pressing "up" while free also jumps
}

const LAYOUTS: Record<Layout, Keys> = {
  solo: {
    left: ['KeyA', 'ArrowLeft'],
    right: ['KeyD', 'ArrowRight'],
    up: ['KeyW', 'ArrowUp'],
    down: ['KeyS', 'ArrowDown'],
    jump: ['Space'],
    grab: ['ShiftLeft', 'ShiftRight', 'KeyJ'],
    dive: ['KeyK', 'KeyX'],
    upJumps: true,
  },
  p1: { left: ['KeyA'], right: ['KeyD'], up: ['KeyW'], down: ['KeyS'], jump: ['Space'], grab: ['KeyF', 'ShiftLeft'], dive: ['KeyG'], upJumps: true },
  p2: {
    left: ['ArrowLeft'],
    right: ['ArrowRight'],
    up: ['ArrowUp'],
    down: ['ArrowDown'],
    jump: ['Numpad0', 'ControlRight'],
    grab: ['Period', 'Numpad1', 'ShiftRight'],
    dive: ['Slash', 'Numpad2'],
    upJumps: true,
  },
};

export interface InputSource {
  kind: 'keyboard' | 'gamepad' | 'touch';
  label: string;
  read(): PlayerInput;
}

class KeyboardSource implements InputSource {
  kind = 'keyboard' as const;
  private jumpN = 0;
  private diveN = 0;
  constructor(
    private held: Set<string>,
    private keys: Keys,
    public label: string,
  ) {}
  press(code: string) {
    if (this.keys.jump.includes(code)) this.jumpN++;
    if (this.keys.dive.includes(code)) this.diveN++;
  }
  read(): PlayerInput {
    const any = (l: string[]) => l.some((k) => this.held.has(k));
    const up = any(this.keys.up);
    const mx = (any(this.keys.right) ? 1 : 0) - (any(this.keys.left) ? 1 : 0);
    return { mx, up, down: any(this.keys.down), grab: any(this.keys.grab), jumpN: this.jumpN, diveN: this.diveN };
  }
}

class GamepadSource implements InputSource {
  kind = 'gamepad' as const;
  private jumpN = 0;
  private diveN = 0;
  private prev: boolean[] = [];
  label: string;
  constructor(
    public index: number,
    private onAction: (a: Action) => void,
  ) {
    this.label = `Gamepad ${index + 1}`;
  }
  read(): PlayerInput {
    const gp = navigator.getGamepads?.()[this.index];
    if (!gp) return { mx: 0, up: false, down: false, grab: false, jumpN: this.jumpN, diveN: this.diveN };
    const b = (i: number) => !!gp.buttons[i]?.pressed;
    const edge = (i: number) => b(i) && !this.prev[i];
    const lb = b(4);
    if (edge(0)) this.jumpN++;
    if (edge(1)) this.diveN++;
    if (lb) {
      if (edge(12)) this.onAction({ a: 'ping', kind: 'go' });
      if (edge(13)) this.onAction({ a: 'ping', kind: 'wait' });
      if (edge(14)) this.onAction({ a: 'ping', kind: 'help' });
      if (edge(15)) this.onAction({ a: 'ping', kind: 'grab' });
      if (edge(3)) this.onAction({ a: 'ping', kind: 'jump' });
    } else {
      if (edge(3)) this.onAction({ a: 'emote', kind: 'cheer' });
    }
    if (edge(9)) this.onAction({ a: 'pause' });
    const ax = gp.axes[0] ?? 0;
    const ay = gp.axes[1] ?? 0;
    const dpad = lb ? 0 : (b(15) ? 1 : 0) - (b(14) ? 1 : 0);
    let mx = Math.abs(ax) > 0.25 ? ax : dpad;
    mx = Math.max(-1, Math.min(1, mx));
    const up = ay < -0.5 || (!lb && b(12));
    const down = ay > 0.5 || (!lb && b(13));
    const grab = b(2) || b(5) || b(7);
    this.prev = gp.buttons.map((x) => x.pressed);
    return { mx, up, down, grab, jumpN: this.jumpN, diveN: this.diveN };
  }
}

export class TouchSource implements InputSource {
  kind = 'touch' as const;
  label = 'Touch';
  mx = 0;
  up = false;
  down = false;
  grab = false;
  jumpN = 0;
  diveN = 0;
  read(): PlayerInput {
    return { mx: this.mx, up: this.up, down: this.down, grab: this.grab, jumpN: this.jumpN, diveN: this.diveN };
  }
}

export class InputManager {
  readonly held = new Set<string>();
  private keyboards: KeyboardSource[] = [];
  private pads = new Map<number, GamepadSource>();
  readonly touch = new TouchSource();
  touchActive = false;
  mouse: { x: number; y: number; t: number } | null = null;
  private listeners: ((a: Action) => void)[] = [];
  /** Sources bound to local player slots, in order. */
  bound: InputSource[] = [];
  enabled = true;

  constructor() {
    window.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      if (!this.enabled) return;
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab'].includes(e.code)) e.preventDefault();
      if (e.repeat) return;
      this.held.add(e.code);
      // Space/Enter on a focused menu button clicks it; it isn't a jump.
      if ((e.target as HTMLElement)?.tagName !== 'BUTTON') for (const k of this.keyboards) k.press(e.code);
      const digit = /^Digit([1-9])$/.exec(e.code);
      if (digit) {
        const n = Number(digit[1]);
        if (n <= 5) this.emit({ a: 'ping', kind: PINGS[n - 1], screen: this.recentMouse() });
        else this.emit({ a: 'emote', kind: EMOTES[n - 6] });
      }
      if (e.code === 'KeyT') this.emit({ a: 'chat' });
      if (e.code === 'Escape' || e.code === 'KeyP') this.emit({ a: 'pause' });
    });
    window.addEventListener('keyup', (e) => this.held.delete(e.code));
    window.addEventListener('blur', () => this.held.clear());
    window.addEventListener('mousemove', (e) => (this.mouse = { x: e.clientX, y: e.clientY, t: performance.now() }));
    window.addEventListener('gamepadconnected', (e) => this.addPad((e as GamepadEvent).gamepad.index));
    window.addEventListener('touchstart', () => (this.touchActive = true), { passive: true });
  }

  private recentMouse() {
    return this.mouse && performance.now() - this.mouse.t < 4000 ? { x: this.mouse.x, y: this.mouse.y } : undefined;
  }

  private addPad(i: number) {
    if (!this.pads.has(i)) this.pads.set(i, new GamepadSource(i, (a) => this.emit(a)));
  }

  onAction(f: (a: Action) => void) {
    this.listeners.push(f);
    return () => (this.listeners = this.listeners.filter((x) => x !== f));
  }

  emit(a: Action) {
    this.listeners.forEach((f) => f(a));
  }

  connectedPads(): number[] {
    const out: number[] = [];
    const gps = navigator.getGamepads?.() ?? [];
    for (const gp of gps) if (gp) out.push(gp.index);
    return out;
  }

  /** Bind input sources for `n` local players. */
  bind(n: number): InputSource[] {
    this.keyboards = [];
    const pads = this.connectedPads();
    pads.forEach((i) => this.addPad(i));
    const sources: InputSource[] = [];
    if (n <= 1) {
      const kb = new KeyboardSource(this.held, LAYOUTS.solo, 'Keyboard');
      this.keyboards.push(kb);
      // Keyboard, touch and the first gamepad all drive player 1.
      const pad = pads.length ? this.pads.get(pads[0]) : undefined;
      sources.push(merge([kb, this.touch, ...(pad ? [pad] : [])]));
    } else {
      const k1 = new KeyboardSource(this.held, LAYOUTS.p1, 'Keyboard left (WASD)');
      const k2 = new KeyboardSource(this.held, LAYOUTS.p2, 'Keyboard right (arrows)');
      this.keyboards.push(k1, k2);
      const padSources = pads.map((i) => this.pads.get(i)!);
      // Gamepads first (they're nicer), then the two keyboard halves.
      const pool: InputSource[] = [...padSources, merge([k1, this.touch]), k2];
      for (let i = 0; i < n; i++) sources.push(pool[i] ?? k2);
    }
    this.bound = sources;
    return sources;
  }

  read(): PlayerInput[] {
    return this.bound.map((s) => s.read());
  }
}

/** Several devices controlling one player: combine their state. */
function merge(list: InputSource[]): InputSource {
  const base = list.map(() => ({ j: 0, d: 0 }));
  let jumpN = 0;
  let diveN = 0;
  return {
    kind: list[0].kind,
    label: list.map((l) => l.label).join(' + '),
    read() {
      let mx = 0;
      let up = false;
      let down = false;
      let grab = false;
      list.forEach((s, i) => {
        const r = s.read();
        if (Math.abs(r.mx) > Math.abs(mx)) mx = r.mx;
        up ||= r.up;
        down ||= r.down;
        grab ||= r.grab;
        if (r.jumpN !== base[i].j) {
          jumpN += Math.max(1, r.jumpN - base[i].j);
          base[i].j = r.jumpN;
        }
        if (r.diveN !== base[i].d) {
          diveN += Math.max(1, r.diveN - base[i].d);
          base[i].d = r.diveN;
        }
      });
      return { mx, up, down, grab, jumpN, diveN };
    },
  };
}
