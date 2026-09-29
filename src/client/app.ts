import { BODY_COLORS, HATS, INVITE_REWARDS, ROPES, SHAPES } from '../shared/cosmetics';
import { BIOMES, BIOME_ORDER, buildCourse, courseId, courseName, dailySpec, dayKey, weekKey, weeklySpec } from '../shared/courses';
import { botName, randomName } from '../shared/names';
import type { LobbyState, ServerMsg } from '../shared/protocol';
import { EMOTES, PINGS, PING_TEXT, QUICK_CHAT, type CourseSpec, type CrewMember, type GameEvent, type RunResult, type Snapshot } from '../shared/types';
import { track, trackSessionStart } from './analytics';
import { setAudio, sfx, unlockAudio, voice } from './audio';
import { ClipBuffer, clipSupported, download, exportClip } from './clip';
import { InputManager, type Action } from './input';
import { Net, api, serverBase } from './net';
import { platform } from './platform';
import { buy, grant, owns, priceOf, profile, recordRun, saveProfile, totalStars } from './profile';
import { GameRenderer } from './render/renderer';
import { LocalSession, OnlineSession, type Session } from './session';
import { Wardrobe } from './wardrobe';

type Mode = 'demo' | 'solo' | 'couch' | 'quick' | 'friends' | 'daily' | 'weekly';

const CARGO_ICON: Record<string, string> = { cake: '🎂', fishtank: '🐠', vase: '🏺', plates: '🍽️' };
const EMOTE_ICON: Record<string, string> = { highfive: '✋', blame: '👉', cheer: '🎉', facepalm: '🤦' };
const PING_ICON: Record<string, string> = { go: '📍', wait: '✋', grab: '🤲', jump: '⬆️', help: '🆘' };

function el<T extends HTMLElement = HTMLElement>(html: string): T {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild as T;
}

function fmtTime(s: number) {
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${m}:${String(r).padStart(2, '0')}`;
}

function starsHtml(n: number, max = 3) {
  return Array.from({ length: max }, (_, i) => `<span class="st ${i < n ? 'on' : ''}">★</span>`).join('');
}

function esc(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export class App {
  readonly renderer: GameRenderer;
  readonly input = new InputManager();
  private ui: HTMLElement;
  private hud: HTMLElement;
  private touchEl: HTMLElement;
  private toastEl: HTMLElement;
  private session: Session | null = null;
  private mode: Mode = 'demo';
  private spec: CourseSpec | null = null;
  private net: Net | null = null;
  private lobby: LobbyState | null = null;
  private clip = new ClipBuffer();
  private paused = false;
  private busy = false; // exporting a clip
  private lastSnap: Snapshot | null = null;
  private lastT = 0;
  private t = 0;
  private resultShown = false;
  private hudBuiltFor: Session | null = null;
  private onlineOk: boolean | null = null;
  private localCount = 1;

  constructor(root: HTMLElement) {
    const canvas = root.querySelector<HTMLCanvasElement>('#game')!;
    this.renderer = new GameRenderer(canvas, root.querySelector('#labels')!, profile().settings.quality);
    this.ui = root.querySelector('#ui')!;
    this.hud = root.querySelector('#hud')!;
    this.touchEl = root.querySelector('#touch')!;
    this.toastEl = root.querySelector('#toast')!;
    window.addEventListener('resize', () => this.renderer.resize());
    this.input.onAction((a) => this.onAction(a));
    const p = profile();
    setAudio({ music: p.settings.music, sfx: p.settings.sfx });
    const unlock = () => unlockAudio();
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.session && !this.session.online && this.mode !== 'demo') this.pause(true);
    });
  }

  async start() {
    trackSessionStart();
    saveProfile();
    this.startDemo();
    this.showMenu();
    requestAnimationFrame((t) => this.loop(t));
    platform.loaded();
    void this.checkOnline();
    void this.handleLinks();
  }

  private async checkOnline() {
    const r = await api<{ ok: boolean; online: number }>('/api/health');
    this.onlineOk = !!r?.ok;
    document.body.classList.toggle('offline', !this.onlineOk);
    const pill = this.ui.querySelector('.online-pill');
    if (pill) pill.textContent = this.onlineOk ? `● ${r!.online} online` : '○ offline: bots only';
    if (this.onlineOk) void this.claimInvites();
  }

  private async handleLinks() {
    const q = new URLSearchParams(location.search);
    const ref = q.get('ref');
    const p = profile();
    if (ref && ref !== p.id && !p.invitedBy && p.sessions <= 1) {
      p.invitedBy = ref;
      saveProfile();
      void api('/api/invites/credit', { ref, id: p.id });
    }
    const room = q.get('room');
    if (room && /^[A-Z]{4}$/.test(room.toUpperCase())) this.joinFriends(room.toUpperCase());
  }

  private async claimInvites() {
    const p = profile();
    const r = await api<{ friends: number }>(`/api/invites/${p.id}`);
    if (!r) return;
    for (const reward of INVITE_REWARDS) {
      const key = `${reward.kind}:${reward.id}`;
      if (r.friends >= reward.friends && !p.rewardsClaimed.includes(key)) {
        p.rewardsClaimed.push(key);
        grant(reward.kind, reward.id);
        this.toast(`🎁 Invite reward unlocked: ${reward.kind === 'hat' ? HATS.find((h) => h.id === reward.id)?.name : ROPES.find((x) => x.id === reward.id)?.name}!`);
      }
    }
    saveProfile();
  }

  // ------------------------------------------------------------------ main loop

  private loop(tms: number) {
    const t = tms / 1000;
    const dt = Math.min(0.1, this.lastT ? t - this.lastT : 1 / 60);
    this.lastT = t;
    this.t += dt;
    if (this.session && !this.busy) {
      const running = !this.paused || this.session.online;
      if (running) {
        const inputs = this.mode === 'demo' || this.paused ? [] : this.input.read();
        const snap = this.session.frame(dt, inputs);
        if (snap) {
          this.lastSnap = snap;
          this.renderer.handleEvents(snap.events, snap);
          if (this.mode !== 'demo') {
            this.playEventSounds(snap.events, snap);
            this.clip.push(snap, dt);
            this.updateHud(snap);
          }
          this.renderer.render(snap, dt, this.t);
        }
      } else if (this.lastSnap) this.renderer.render({ ...this.lastSnap, events: [] }, 0, this.t);
    }
    requestAnimationFrame((x) => this.loop(x));
  }

  private playEventSounds(events: GameEvent[], s: Snapshot) {
    const crew = this.session?.crew ?? [];
    const pitch = (p: number) => 0.8 + ((crew[p]?.look.body ?? 0) % 6) * 0.09 + (crew[p]?.look.shape === 3 ? -0.15 : 0);
    const pan = (x: number) => Math.max(-0.8, Math.min(0.8, (x - (s.players[0]?.x ?? x)) / 10));
    for (const e of events) {
      switch (e.e) {
        case 'jump':
          sfx('jump', pan(s.players[e.p]?.x ?? 0));
          break;
        case 'land':
          sfx('land');
          break;
        case 'grab':
          sfx('grab');
          break;
        case 'dive':
          sfx('dive');
          break;
        case 'panic':
          sfx('panic');
          voice('Whoa!', pitch(e.p));
          break;
        case 'ouch':
          if (e.kind === 'heat') {
            sfx('sizzle');
            voice('Hot hot hot!', pitch(e.p) * 1.2);
          } else if (e.kind === 'water') sfx('splash');
          else {
            sfx('ouch');
            if (this.session?.course.movers.some((m) => m.kind === 'paw')) sfx('meow');
          }
          break;
        case 'damage':
          sfx('crunch');
          break;
        case 'layer':
          sfx('crunch');
          break;
        case 'checkpoint':
          sfx('checkpoint');
          if (e.i === 1) track('first_checkpoint', { course: this.session!.course.id, t: Math.round(s.time) });
          break;
        case 'drop':
          sfx('drop');
          break;
        case 'fell':
          voice('Aaaaaah!', pitch(e.p));
          sfx('splash');
          break;
        case 'collect':
          sfx('collect');
          break;
        case 'delivered':
          sfx('delivered');
          platform.happyTime();
          break;
        case 'kick':
          sfx('kick');
          break;
        case 'ping':
          if (!this.renderer.blocked.has(crew[e.p]?.id ?? '')) {
            sfx('pop');
            voice(PING_TEXT[e.kind], pitch(e.p));
          }
          break;
        case 'emote':
          if (!this.renderer.blocked.has(crew[e.p]?.id ?? '')) voice(e.kind === 'cheer' ? 'Woohoo!' : e.kind === 'blame' ? 'Your fault!' : 'Heh', pitch(e.p));
          break;
        case 'chat':
          if (!this.renderer.blocked.has(crew[e.p]?.id ?? '')) voice(QUICK_CHAT[e.i] ?? '', pitch(e.p));
          break;
        default:
          break;
      }
    }
  }

  private onAction(a: Action) {
    if (!this.session || this.mode === 'demo' || this.busy) return;
    if (a.a === 'pause') {
      this.pause(!this.paused);
      return;
    }
    if (this.paused || this.session.result) return;
    const me = this.lastSnap?.players[this.session.localSlots[0]];
    if (a.a === 'ping') {
      let x = me ? me.x + me.f * 2 : 0;
      let y = me ? me.y : 0;
      if (a.screen) ({ x, y } = this.renderer.screenToWorld(a.screen.x, a.screen.y));
      this.session.ping(0, a.kind, x, y);
    } else if (a.a === 'emote') this.session.emote(0, a.kind);
    else if (a.a === 'chat') this.toggleChat();
  }

  // ------------------------------------------------------------------ sessions

  private startDemo() {
    this.endSession();
    const crew: CrewMember[] = [0, 1, 2].map((i) => ({ id: 'demo' + i, name: botName(i).replace(' (bot)', ''), look: { body: [0, 4, 3][i], shape: i % 2, hat: ['party', 'chef', 'beanie'][i], rope: 'classic' }, bot: true }));
    const s = new LocalSession({ biome: 'kitchen', index: 0 }, crew, []);
    s.demo = true;
    s.onResult = () => setTimeout(() => this.mode === 'demo' && this.startDemo(), 100);
    this.session = s;
    this.mode = 'demo';
    this.renderer.localSlots = [];
    this.renderer.focusShift = matchMedia('(max-width: 760px)').matches ? 0 : 0.22;
    this.renderer.setCourse(s.course, crew);
    this.hud.innerHTML = '';
    this.hud.hidden = true;
    this.touchEl.hidden = true;
  }

  private endSession() {
    this.session?.dispose();
    this.session = null;
    this.lastSnap = null;
    this.paused = false;
    this.resultShown = false;
    this.hudBuiltFor = null;
    platform.gameplayStop();
  }

  private me(): CrewMember {
    const p = profile();
    return { id: p.id, name: p.name, look: p.look, bot: false };
  }

  startLocal(spec: CourseSpec, mode: Mode, humans: number, bots: number) {
    this.endSession();
    this.clip.clear();
    const p = profile();
    const crew: CrewMember[] = [];
    const human = (i: number): CrewMember =>
      i === 0 ? this.me() : { id: `local${i}`, name: randomName(i * 7919 + p.id.length), look: { body: (p.look.body + i * 3) % 12, shape: i % 2, hat: HATS[(i * 2) % 9].id, rope: p.look.rope }, bot: false };
    const bot = (i: number): CrewMember => ({ id: `bot${i}`, name: botName(i), look: { body: (p.look.body + 2 + i * 4) % 12, shape: (i + 1) % 2, hat: ['chef', 'beanie', 'bucket'][i % 3], rope: 'classic' }, bot: true });
    // Humans in the middle of the rope, bots at the ends so the player is in the thick of it.
    for (let i = 0; i < humans; i++) crew.push(human(i));
    for (let i = 0; i < bots; i++) {
      if (i % 2 === 0) crew.push(bot(i));
      else crew.unshift(bot(i));
    }
    const localSlots = crew.map((c, i) => (!c.bot ? i : -1)).filter((i) => i >= 0);
    const s = new LocalSession(spec, crew, localSlots);
    s.onResult = (r) => this.finish(r);
    this.session = s;
    this.spec = spec;
    this.mode = mode;
    this.localCount = humans;
    this.renderer.focusShift = 0;
    this.input.bind(humans);
    this.renderer.localSlots = localSlots;
    this.renderer.setCourse(s.course, crew);
    this.ui.innerHTML = '';
    this.buildHud();
    platform.gameplayStart();
    track('course_start', { course: s.course.id, mode, crew: crew.length, humans });
    track('crew_size', { n: crew.length, humans });
  }

  private startOnline(m: Extract<ServerMsg, { t: 'start' }>) {
    if (!this.net) return;
    this.endSession();
    this.clip.clear();
    const s = new OnlineSession(this.net, m.spec, m.crew, [m.slot]);
    s.onResult = (r) => this.finish(r);
    s.onCrew = (c) => {
      this.renderer.setCrew(c);
      this.toast('Crew changed: ' + c.map((x) => x.name).join(', '));
    };
    this.session = s;
    this.spec = m.spec;
    this.localCount = 1;
    this.renderer.focusShift = 0;
    this.input.bind(1);
    this.renderer.localSlots = [m.slot];
    this.renderer.setCourse(s.course, m.crew);
    this.ui.innerHTML = '';
    this.buildHud();
    platform.gameplayStart();
    track('course_start', { course: s.course.id, mode: this.mode, crew: m.crew.length, humans: m.crew.filter((c) => !c.bot).length });
    track('crew_size', { n: m.crew.length, humans: m.crew.filter((c) => !c.bot).length });
  }

  private finish(r: RunResult) {
    if (this.resultShown) return;
    this.resultShown = true;
    platform.gameplayStop();
    const p = profile();
    let coins = r.coins;
    const isDaily = this.spec && this.spec.index < 0;
    const dKey = this.spec?.index === -1 ? `d${dayKey()}` : `w${weekKey()}`;
    if (isDaily && !p.dailyDone[dKey]) coins += 20;
    if (isDaily) p.dailyDone[dKey] = Math.max(p.dailyDone[dKey] ?? 0, r.stars);
    const newBest = recordRun(r.courseId, r.stars, r.time, r.damage, coins);
    track('course_complete', { course: r.courseId, stars: r.stars, time: r.time, damage: r.damage, mode: this.mode });
    if (isDaily && !this.session?.online) void api('/api/daily/submit', { key: this.spec!.index === -1 ? `d${this.spec!.seed}` : `w${this.spec!.seed}`, crew: r.crew, stars: r.stars, time: r.time, damage: r.damage });
    this.showResults({ ...r, coins }, newBest);
  }

  // ------------------------------------------------------------------ HUD

  private buildHud() {
    const s = this.session!;
    this.hudBuiltFor = s;
    const c = s.course;
    const icon = CARGO_ICON[c.cargo];
    const ticks = c.checkpoints
      .slice(1)
      .map((cp) => `<i style="left:${((cp.x - c.checkpoints[0].x) / (c.goal.x - c.checkpoints[0].x)) * 100}%"></i>`)
      .join('');
    this.hud.hidden = false;
    this.hud.innerHTML = `
      <div class="hud-top">
        <div class="hud-course"><b>${esc(c.name)}</b><span class="hud-time">0:00</span><small>par ${fmtTime(c.parTime)}</small></div>
        <div class="hud-progress"><div class="bar"><div class="fill"></div>${ticks}</div><div class="mark">${icon}</div><div class="goal">🏁</div></div>
        <div class="hud-cargo"><span class="icon">${icon}</span><div class="meter"><div class="fill"></div></div><span class="pct">100%</span></div>
        <div class="hud-stars">⭐ <span>0</span>/${c.collectibles.length}</div>
        <button class="hud-btn hud-pause" title="Pause (Esc)">⏸</button>
      </div>
      <div class="hud-comms">
        ${PINGS.map((k, i) => `<button class="ping" data-ping="${k}" title="${PING_TEXT[k]} (${i + 1})">${PING_ICON[k]}</button>`).join('')}
        <span class="sep"></span>
        ${EMOTES.map((k, i) => `<button class="emote" data-emote="${k}" title="${k} (${i + 6})">${EMOTE_ICON[k]}</button>`).join('')}
        <button class="chat" title="Quick chat (T)">💬</button>
      </div>
      <div class="hud-chat" hidden>${QUICK_CHAT.map((q, i) => `<button data-chat="${i}">${esc(q)}</button>`).join('')}</div>
      ${!profile().settings.seenHelp ? this.helpStrip() : ''}
      <div class="hud-banner" hidden></div>
    `;
    this.hud.querySelector('.hud-pause')!.addEventListener('click', () => this.pause(true));
    this.hud.querySelectorAll<HTMLButtonElement>('[data-ping]').forEach((b) =>
      b.addEventListener('click', () => this.onAction({ a: 'ping', kind: b.dataset.ping as (typeof PINGS)[number] })),
    );
    this.hud.querySelectorAll<HTMLButtonElement>('[data-emote]').forEach((b) =>
      b.addEventListener('click', () => this.onAction({ a: 'emote', kind: b.dataset.emote as (typeof EMOTES)[number] })),
    );
    this.hud.querySelector('.chat')!.addEventListener('click', () => this.toggleChat());
    this.hud.querySelectorAll<HTMLButtonElement>('[data-chat]').forEach((b) =>
      b.addEventListener('click', () => {
        this.session?.chat(0, Number(b.dataset.chat));
        this.toggleChat(false);
      }),
    );
    const help = this.hud.querySelector('.hud-help');
    if (help) {
      setTimeout(() => help.classList.add('fade'), 25000);
      help.querySelector('button')?.addEventListener('click', () => {
        help.remove();
        profile().settings.seenHelp = true;
        saveProfile();
      });
    }
    this.buildTouch();
    const banner = this.hud.querySelector<HTMLElement>('.hud-banner')!;
    banner.hidden = false;
    banner.innerHTML = `<b>${esc(c.name)}</b><span>Carry the ${c.cargo === 'fishtank' ? 'fish tank' : c.cargo === 'plates' ? 'plates' : c.cargo} ${icon} to the ${c.scene === 'party' ? 'birthday party 🎉' : c.scene === 'aquarium' ? 'new aquarium 🐟' : 'grandma 👵'}${c.twist.id !== 'none' ? ` · Twist: ${esc(c.twist.label)}` : ''}</span>`;
    setTimeout(() => banner.classList.add('fade'), 3500);
  }

  private helpStrip() {
    if (this.localCount > 1)
      return `<div class="hud-help"><span><b>P1</b> A/D move · W jump · F grab · G dive</span><span><b>P2</b> ←/→ move · ↑ jump · . grab · / dive</span><span>Gamepads: stick · A jump · X/RB grab · B dive</span><button>Got it</button></div>`;
    return `<div class="hud-help"><span><kbd>A</kbd><kbd>D</kbd> move</span><span><kbd>Space</kbd>/<kbd>W</kbd> jump</span><span><kbd>Shift</kbd>/<kbd>J</kbd> hold to grab</span><span><kbd>K</kbd> dive</span><span><kbd>W</kbd>/<kbd>S</kbd> climb rope</span><span><kbd>1-5</kbd> ping · <kbd>6-9</kbd> emote</span><button>Got it</button></div>`;
  }

  private toggleChat(force?: boolean) {
    const c = this.hud.querySelector<HTMLElement>('.hud-chat');
    if (c) c.hidden = force === undefined ? !c.hidden : !force;
  }

  private buildTouch() {
    const coarse = matchMedia('(pointer: coarse)').matches || this.input.touchActive;
    this.touchEl.hidden = !coarse || this.localCount > 1;
    if (this.touchEl.hidden) return;
    this.touchEl.innerHTML = `
      <div class="stick"><div class="knob"></div></div>
      <div class="tbtns">
        <button class="t-grab">GRAB</button>
        <button class="t-jump">JUMP</button>
        <button class="t-dive">DIVE</button>
      </div>`;
    const t = this.input.touch;
    const stick = this.touchEl.querySelector<HTMLElement>('.stick')!;
    const knob = this.touchEl.querySelector<HTMLElement>('.knob')!;
    let sid: number | null = null;
    let cx = 0;
    let cy = 0;
    const move = (x: number, y: number) => {
      const dx = Math.max(-50, Math.min(50, x - cx));
      const dy = Math.max(-50, Math.min(50, y - cy));
      knob.style.transform = `translate(${dx}px, ${dy}px)`;
      t.mx = Math.abs(dx) > 10 ? dx / 50 : 0;
      t.up = dy < -28;
      t.down = dy > 28;
    };
    stick.addEventListener('pointerdown', (e) => {
      sid = e.pointerId;
      const r = stick.getBoundingClientRect();
      cx = r.left + r.width / 2;
      cy = r.top + r.height / 2;
      stick.setPointerCapture(e.pointerId);
      move(e.clientX, e.clientY);
    });
    stick.addEventListener('pointermove', (e) => e.pointerId === sid && move(e.clientX, e.clientY));
    const end = (e: PointerEvent) => {
      if (e.pointerId !== sid) return;
      sid = null;
      knob.style.transform = '';
      t.mx = 0;
      t.up = t.down = false;
    };
    stick.addEventListener('pointerup', end);
    stick.addEventListener('pointercancel', end);
    const hold = (sel: string, on: () => void, off?: () => void) => {
      const b = this.touchEl.querySelector<HTMLElement>(sel)!;
      b.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        b.classList.add('down');
        on();
      });
      const up = () => {
        b.classList.remove('down');
        off?.();
      };
      b.addEventListener('pointerup', up);
      b.addEventListener('pointercancel', up);
      b.addEventListener('pointerleave', up);
    };
    hold('.t-jump', () => t.jumpN++);
    hold('.t-dive', () => t.diveN++);
    hold('.t-grab', () => (t.grab = true), () => (t.grab = false));
  }

  private updateHud(s: Snapshot) {
    const sess = this.session;
    if (!sess || this.hudBuiltFor !== sess) return;
    const c = sess.course;
    const q = <T extends HTMLElement>(sel: string) => this.hud.querySelector<T>(sel);
    const time = q('.hud-time');
    if (time) time.textContent = fmtTime(s.time);
    const x0 = c.checkpoints[0].x;
    const u = Math.max(0, Math.min(1, (s.cargo.parts[0] - x0) / (c.goal.x - x0)));
    const fill = q('.hud-progress .fill');
    if (fill) fill.style.width = `${u * 100}%`;
    const mark = q('.hud-progress .mark');
    if (mark) mark.style.left = `${u * 100}%`;
    const intact = Math.max(0, 100 - s.cargo.damage);
    const m = q('.hud-cargo .fill');
    if (m) {
      m.style.width = `${intact}%`;
      m.style.background = intact > 60 ? '#3ddc84' : intact > 30 ? '#ffc53d' : '#ff4d4d';
    }
    const pct = q('.hud-cargo .pct');
    if (pct) pct.textContent = `${Math.round(intact)}%`;
    const st = q('.hud-stars span');
    if (st) st.textContent = String(s.collected.length);
    if (s.events.some((e) => e.e === 'damage')) {
      const cargo = q('.hud-cargo');
      cargo?.classList.remove('hit');
      void cargo?.offsetWidth;
      cargo?.classList.add('hit');
    }
  }

  // ------------------------------------------------------------------ screens

  private screen(html: string, cls = ''): HTMLElement {
    this.ui.innerHTML = '';
    const s = el(`<div class="screen ${cls}">${html}</div>`);
    this.ui.appendChild(s);
    s.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => sfx('click')));
    return s;
  }

  showMenu() {
    if (this.mode !== 'demo') this.startDemo();
    this.leaveNet();
    const p = profile();
    const daily = dailySpec();
    const dailyCourse = buildCourse(daily);
    const doneToday = p.dailyDone[`d${dayKey()}`];
    const s = this.screen(
      `
      <div class="menu">
        <div class="logo"><span>CARRY</span><span>CREW</span></div>
        <div class="tagline">Tied together. Carry the cake. Don't drop it.</div>
        <div class="player-chip">
          <span class="dot" style="--c:#${BODY_COLORS[p.look.body].toString(16).padStart(6, '0')}"></span>
          <b class="pname">${esc(p.name)}</b>
          <button class="reroll" title="New random name">🎲</button>
          <span class="coins">🪙 ${p.coins}</span><span class="tstars">★ ${totalStars()}</span>
        </div>
        <button class="big play">▶ PLAY</button>
        <div class="sub">Quick crew: jump in with other players (bots fill in instantly)</div>
        <div class="row">
          <button class="mid bots">🤖 Play with bots</button>
          <button class="mid friends">👯 Friends crew</button>
          <button class="mid couch">🎮 Couch co-op</button>
        </div>
        <div class="row">
          <button class="card daily">
            <b>📅 Daily course</b>
            <span>${esc(BIOMES[daily.biome].name)} · ${esc(dailyCourse.twist.label)}</span>
            <em>${doneToday ? starsHtml(doneToday) + ' done today' : '+20 🪙 bonus'}</em>
          </button>
          <button class="card weekly"><b>🏆 Weekly challenge</b><span>${esc(BIOMES[weeklySpec().biome].name)} · long course</span><em>New every Monday</em></button>
        </div>
        <div class="row small">
          <button class="courses">🗺️ Courses</button>
          <button class="wardrobe">🎩 Wardrobe</button>
          <button class="board">📊 Daily board</button>
          <button class="settings">⚙️ Settings</button>
        </div>
        <div class="online-pill">${this.onlineOk === null ? '…' : this.onlineOk ? '● online' : '○ offline: bots only'}</div>
      </div>`,
      'menu-screen',
    );
    s.querySelector('.play')!.addEventListener('click', () => this.quickCrew());
    s.querySelector('.bots')!.addEventListener('click', () => this.showCourses('solo'));
    s.querySelector('.couch')!.addEventListener('click', () => this.showCourses('couch'));
    s.querySelector('.friends')!.addEventListener('click', () => this.showFriends());
    s.querySelector('.daily')!.addEventListener('click', () => this.startLocal(daily, 'daily', 1, 2));
    s.querySelector('.weekly')!.addEventListener('click', () => this.startLocal(weeklySpec(), 'weekly', 1, 3));
    s.querySelector('.courses')!.addEventListener('click', () => this.showCourses('solo'));
    s.querySelector('.wardrobe')!.addEventListener('click', () => this.showWardrobe());
    s.querySelector('.board')!.addEventListener('click', () => this.showBoard());
    s.querySelector('.settings')!.addEventListener('click', () => this.showSettings());
    s.querySelector('.reroll')!.addEventListener('click', () => {
      p.name = randomName();
      saveProfile();
      s.querySelector('.pname')!.textContent = p.name;
    });
  }

  showCourses(kind: 'solo' | 'couch') {
    const p = profile();
    let bots = kind === 'solo' ? 2 : 1;
    let humans = kind === 'couch' ? Math.max(2, Math.min(4, this.input.connectedPads().length + 2)) : 1;
    const s = this.screen(
      `
      <div class="panel wide">
        <h2>${kind === 'solo' ? '🤖 Play with bots' : '🎮 Couch co-op'}</h2>
        <div class="crew-pick">
          ${kind === 'couch' ? `<label>Players on this computer <select class="humans">${[2, 3, 4].map((n) => `<option ${n === humans ? 'selected' : ''}>${n}</option>`).join('')}</select></label><small>Players 1–2 share the keyboard; plug in gamepads for 3–4.</small>` : ''}
          <label>Bot crewmates <select class="bots">${[0, 1, 2, 3].map((n) => `<option ${n === bots ? 'selected' : ''} ${kind === 'solo' && n === 0 ? '' : ''}>${n}</option>`).join('')}</select></label>
        </div>
        <div class="biomes">
          ${BIOME_ORDER.map((b) => {
            const info = BIOMES[b];
            return `<div class="biome ${b}"><h3>${esc(info.name)} <span>${CARGO_ICON[info.cargo]}</span></h3>
              ${info.courses
                .map((c, i) => {
                  const id = courseId({ biome: b, index: i });
                  const best = p.best[id];
                  return `<button class="course" data-b="${b}" data-i="${i}"><b>${i + 1}. ${esc(c.name)}</b><span class="stars">${starsHtml(p.stars[id] ?? 0)}</span><small>${best ? 'best ' + fmtTime(best.time) : ['Easy', 'Medium', 'Hard'][c.d]}</small></button>`;
                })
                .join('')}</div>`;
          }).join('')}
        </div>
        <button class="back">← Back</button>
      </div>`,
    );
    s.querySelector<HTMLSelectElement>('.bots')!.addEventListener('change', (e) => (bots = Number((e.target as HTMLSelectElement).value)));
    s.querySelector<HTMLSelectElement>('.humans')?.addEventListener('change', (e) => (humans = Number((e.target as HTMLSelectElement).value)));
    s.querySelectorAll<HTMLButtonElement>('.course').forEach((b) =>
      b.addEventListener('click', () => {
        const spec: CourseSpec = { biome: b.dataset.b as CourseSpec['biome'], index: Number(b.dataset.i) };
        const total = humans + bots;
        if (total > 4) bots = 4 - humans;
        if (humans + bots < 1) bots = 1;
        this.startLocal(spec, kind, humans, bots);
      }),
    );
    s.querySelector('.back')!.addEventListener('click', () => this.showMenu());
  }

  showSettings() {
    const p = profile();
    const s = this.screen(`
      <div class="panel">
        <h2>⚙️ Settings</h2>
        <label class="toggle"><input type="checkbox" class="music" ${p.settings.music ? 'checked' : ''}> Music</label>
        <label class="toggle"><input type="checkbox" class="sfx" ${p.settings.sfx ? 'checked' : ''}> Sound effects</label>
        <label class="toggle"><input type="checkbox" class="quality" ${p.settings.quality === 'high' ? 'checked' : ''}> High quality graphics (shadows, smoothing)</label>
        <h3>Controls</h3>
        <table class="controls">
          <tr><td>Move</td><td><kbd>A</kbd><kbd>D</kbd> / <kbd>←</kbd><kbd>→</kbd></td></tr>
          <tr><td>Jump</td><td><kbd>Space</kbd> / <kbd>W</kbd></td></tr>
          <tr><td>Grab (hold)</td><td><kbd>Shift</kbd> / <kbd>J</kbd> — ledges, the rope, the cargo</td></tr>
          <tr><td>Climb rope / pull up</td><td><kbd>W</kbd> <kbd>S</kbd> while holding</td></tr>
          <tr><td>Dive</td><td><kbd>K</kbd> / <kbd>X</kbd></td></tr>
          <tr><td>Panic grab</td><td>Hold grab while falling — once per checkpoint</td></tr>
          <tr><td>Pings</td><td><kbd>1</kbd>–<kbd>5</kbd> (at your mouse pointer)</td></tr>
          <tr><td>Emotes / chat</td><td><kbd>6</kbd>–<kbd>9</kbd> · <kbd>T</kbd></td></tr>
          <tr><td>Gamepad</td><td>Stick · A jump · X/RB grab · B dive · LB+D-pad ping</td></tr>
        </table>
        <p class="note">Carry Crew has no voice or text chat: only pings, emotes and preset phrases. Names are made from a safe word list.</p>
        <button class="reset-help">Show control tips again</button>
        <button class="back">← Back</button>
      </div>`);
    const save = () => {
      p.settings.music = s.querySelector<HTMLInputElement>('.music')!.checked;
      p.settings.sfx = s.querySelector<HTMLInputElement>('.sfx')!.checked;
      p.settings.quality = s.querySelector<HTMLInputElement>('.quality')!.checked ? 'high' : 'low';
      setAudio({ music: p.settings.music, sfx: p.settings.sfx });
      this.renderer.setQuality(p.settings.quality);
      saveProfile();
    };
    s.querySelectorAll('input').forEach((i) => i.addEventListener('change', save));
    s.querySelector('.reset-help')!.addEventListener('click', () => {
      p.settings.seenHelp = false;
      saveProfile();
      this.toast('Tips will show next course');
    });
    s.querySelector('.back')!.addEventListener('click', () => (this.session && this.mode !== 'demo' ? this.showPause() : this.showMenu()));
  }

  showWardrobe() {
    const s = this.screen(`<div class="panel wide wardrobe-panel"><h2>🎩 Wardrobe <span class="coins">🪙 <b></b></span></h2><div class="wardrobe"></div><button class="back">← Back</button></div>`);
    const coins = s.querySelector<HTMLElement>('.coins b')!;
    const host = s.querySelector<HTMLElement>('.wardrobe')!;
    const w = new Wardrobe(host);
    const render = () => {
      const p = profile();
      coins.textContent = String(p.coins);
      w.setLook(p.look);
      const item = (kind: 'color' | 'shape' | 'hat' | 'rope', id: number | string, label: string, inner: string) => {
        const own = owns(kind, id);
        const price = priceOf(kind, id);
        const on =
          (kind === 'color' && p.look.body === id) || (kind === 'shape' && p.look.shape === id) || (kind === 'hat' && p.look.hat === id) || (kind === 'rope' && p.look.rope === id);
        const tag = on ? 'equipped' : own ? '' : price < 0 ? '🎁 invite a friend' : `🪙 ${price}`;
        return `<button class="item ${on ? 'on' : ''} ${own ? 'own' : 'locked'}" data-k="${kind}" data-id="${id}" title="${esc(label)}">${inner}<small>${esc(label)}</small><em>${tag}</em></button>`;
      };
      host.querySelector('.tabs')?.remove();
      const tabs = el(`<div class="tabs">
        <h4>Colour</h4><div class="grid">${BODY_COLORS.map((c, i) => item('color', i, 'Colour ' + (i + 1), `<span class="sw" style="background:#${c.toString(16).padStart(6, '0')}"></span>`)).join('')}</div>
        <h4>Body</h4><div class="grid">${SHAPES.map((x) => item('shape', x.id, x.name, `<span class="ico">${['🫘', '⚪', '🧊', '🥒'][x.id]}</span>`)).join('')}</div>
        <h4>Hat</h4><div class="grid">${HATS.map((x) => item('hat', x.id, x.name, `<span class="ico">${({ none: '🚫', party: '🥳', chef: '👨‍🍳', beanie: '🧢', propeller: '🚁', bucket: '🪣', crown: '👑', cone: '🚧', frog: '🐸', halo: '😇' } as Record<string, string>)[x.id]}</span>`)).join('')}</div>
        <h4>Rope</h4><div class="grid">${ROPES.map((x) => item('rope', x.id, x.name, `<span class="rope-sw" style="background:linear-gradient(90deg,${x.colors.map((c) => '#' + c.toString(16).padStart(6, '0')).join(',')})"></span>`)).join('')}</div>
      </div>`);
      host.appendChild(tabs);
      tabs.querySelectorAll<HTMLButtonElement>('.item').forEach((b) =>
        b.addEventListener('click', () => {
          const kind = b.dataset.k as 'color' | 'shape' | 'hat' | 'rope';
          const id = kind === 'color' || kind === 'shape' ? Number(b.dataset.id) : b.dataset.id!;
          if (!owns(kind, id)) {
            if (priceOf(kind, id) < 0) {
              this.toast('Invite a friend to unlock this! (Friends crew → copy invite link)');
              return;
            }
            if (!buy(kind, id)) {
              this.toast('Not enough coins yet: deliver more cargo!');
              return;
            }
            sfx('collect');
          }
          if (kind === 'color') p.look.body = id as number;
          else if (kind === 'shape') p.look.shape = id as number;
          else if (kind === 'hat') p.look.hat = id as string;
          else p.look.rope = id as string;
          saveProfile();
          render();
        }),
      );
    };
    render();
    s.querySelector('.back')!.addEventListener('click', () => {
      w.dispose();
      this.showMenu();
    });
  }

  async showBoard() {
    const s = this.screen(`<div class="panel"><h2>📊 Daily course leaderboard</h2><div class="board-body">Loading…</div><button class="back">← Back</button></div>`);
    s.querySelector('.back')!.addEventListener('click', () => this.showMenu());
    const body = s.querySelector<HTMLElement>('.board-body')!;
    const key = `d${dailySpec().seed}`;
    const r = await api<{ entries: { crew: string[]; stars: number; time: number; damage: number }[] }>(`/api/daily/board?key=${key}`);
    if (!r) body.innerHTML = '<p>The leaderboard needs the game server. Play the daily course with bots anyway!</p>';
    else if (!r.entries.length) body.innerHTML = '<p>No deliveries yet today. Be the first crew!</p>';
    else
      body.innerHTML = `<ol class="board">${r.entries
        .slice(0, 20)
        .map((e) => `<li><span class="crew">${e.crew.map(esc).join(', ')}</span><span>${starsHtml(e.stars)}</span><span>${fmtTime(e.time)}</span><span>${Math.max(0, 100 - e.damage)}% intact</span></li>`)
        .join('')}</ol>`;
  }

  // ------------------------------------------------------------------ pause / results

  pause(on: boolean) {
    if (!this.session || this.mode === 'demo' || this.session.result) return;
    this.paused = on;
    this.input.held.clear();
    if (on) {
      platform.gameplayStop();
      this.showPause();
    } else {
      platform.gameplayStart();
      this.ui.innerHTML = '';
    }
  }

  private showPause() {
    const sess = this.session!;
    const others = sess.crew.filter((c, i) => !c.bot && !sess.localSlots.includes(i));
    const s = this.screen(`
      <div class="panel">
        <h2>${sess.online ? '⏸ Menu (the game keeps going!)' : '⏸ Paused'}</h2>
        <button class="big resume">▶ Resume</button>
        <button class="clip" ${clipSupported() && this.clip.length ? '' : 'disabled'}>🎬 Save last 15 seconds as a clip</button>
        ${
          others.length
            ? `<h3>Crew</h3><ul class="crewlist">${others
                .map(
                  (c) => `<li><b>${esc(c.name)}</b>
              <button data-block="${c.id}">${this.renderer.blocked.has(c.id) ? 'Unblock' : 'Block'}</button>
              <button data-report="${c.id}">Report</button>
              <button data-kick="${c.id}">Vote kick</button></li>`,
                )
                .join('')}</ul>`
            : ''
        }
        <button class="settings">⚙️ Settings & controls</button>
        <button class="quit">🚪 Quit to menu</button>
      </div>`);
    s.querySelector('.resume')!.addEventListener('click', () => this.pause(false));
    s.querySelector('.clip')!.addEventListener('click', () => this.saveClip());
    s.querySelector('.settings')!.addEventListener('click', () => this.showSettings());
    s.querySelector('.quit')!.addEventListener('click', () => {
      this.endSession();
      this.showMenu();
    });
    s.querySelectorAll<HTMLButtonElement>('[data-block]').forEach((b) =>
      b.addEventListener('click', () => {
        const id = b.dataset.block!;
        if (this.renderer.blocked.has(id)) this.renderer.blocked.delete(id);
        else this.renderer.blocked.add(id);
        b.textContent = this.renderer.blocked.has(id) ? 'Unblock' : 'Block';
      }),
    );
    s.querySelectorAll<HTMLButtonElement>('[data-report]').forEach((b) =>
      b.addEventListener('click', () => {
        this.net?.send({ t: 'report', target: b.dataset.report!, reason: 'griefing' });
        b.disabled = true;
        b.textContent = 'Reported';
        this.toast('Thanks. Our team will look at it.');
      }),
    );
    s.querySelectorAll<HTMLButtonElement>('[data-kick]').forEach((b) =>
      b.addEventListener('click', () => {
        this.net?.send({ t: 'votekick', target: b.dataset.kick! });
        b.disabled = true;
        b.textContent = 'Voted';
      }),
    );
  }

  private async saveClip() {
    if (this.busy || !this.session) return;
    const frames = this.clip.snapshot();
    if (!frames.length) return;
    this.busy = true;
    const note = this.screen(`<div class="panel"><h2>🎬 Making your clip…</h2><div class="progress"><div></div></div><p>Replaying the last ${Math.round(frames.length / 30)} seconds.</p></div>`, 'clear');
    const bar = note.querySelector<HTMLElement>('.progress div')!;
    try {
      const blob = await exportClip(this.renderer, frames, this.session.course.name, (u) => (bar.style.width = `${u * 100}%`));
      if (blob) {
        download(blob, `carry-crew-${this.session.course.id}-${Date.now()}.${blob.type.includes('mp4') ? 'mp4' : 'webm'}`);
        track('clip_saved', { course: this.session.course.id });
        this.toast('Clip saved! Share it 🎉');
      }
    } finally {
      this.busy = false;
    }
    if (this.session?.result) this.showResults(this.session.result, false);
    else this.showPause();
  }

  private showResults(r: RunResult, newBest: boolean) {
    const sess = this.session;
    const c = sess?.course;
    const icon = c ? CARGO_ICON[c.cargo] : '🎂';
    const intact = Math.max(0, 100 - r.damage);
    const next = this.nextSpec();
    const isDaily = !!this.spec && this.spec.index < 0;
    const s = this.screen(`
      <div class="panel results">
        <h2>Delivered! ${icon}</h2>
        <div class="big-stars">${starsHtml(0)}</div>
        ${newBest ? '<div class="newbest">New best!</div>' : ''}
        <div class="stats">
          <div><b>${intact}%</b><span>${c?.cargo === 'fishtank' ? 'fish happy' : 'intact'}</span></div>
          <div><b>${fmtTime(r.time)}</b><span>par ${fmtTime(r.par)}</span></div>
          <div><b>${r.collectibles}/${r.totalCollectibles}</b><span>⭐ found</span></div>
          <div><b class="coinval">+${r.coins}</b><span>🪙 coins</span></div>
        </div>
        <p class="hint">${r.stars < 3 ? (r.damage > 15 ? 'Tip: fewer bumps = more stars. Carry it level, jump together!' : 'Tip: beat the par time for the third star.') : 'Perfect delivery! 🎉'}</p>
        <div class="row">
          ${next && !sess?.online ? '<button class="big next">Next course ▶</button>' : ''}
          ${sess?.online && this.mode === 'friends' ? '<button class="big lobbyback">Back to crew lobby</button>' : ''}
          ${sess?.online && this.mode === 'quick' ? '<button class="big requeue">Find a new crew ▶</button>' : ''}
          ${!sess?.online ? '<button class="mid again">↻ Play again</button>' : ''}
        </div>
        <div class="row small">
          <button class="clip" ${clipSupported() && this.clip.length ? '' : 'disabled'}>🎬 Save clip</button>
          <button class="double">📺 Double coins</button>
          ${isDaily ? '<button class="board">📊 Leaderboard</button>' : ''}
          <button class="menu">🏠 Menu</button>
        </div>
      </div>`);
    const starsEl = s.querySelector<HTMLElement>('.big-stars')!;
    for (let i = 1; i <= r.stars; i++)
      setTimeout(() => {
        starsEl.innerHTML = starsHtml(i);
        sfx('star');
      }, 400 * i);
    s.querySelector('.next')?.addEventListener('click', () => this.afterBreak(() => this.startLocal(next!, this.mode === 'couch' ? 'couch' : 'solo', this.localCount, this.session!.crew.filter((x) => x.bot).length)));
    s.querySelector('.again')?.addEventListener('click', () => {
      const bots = this.session!.crew.filter((x) => x.bot).length;
      this.afterBreak(() => this.startLocal(this.spec!, this.mode, this.localCount, bots));
    });
    s.querySelector('.lobbyback')?.addEventListener('click', () => {
      this.endSession();
      this.startDemo();
      this.net?.send({ t: 'again' });
      if (this.lobby) this.showLobby(this.lobby);
    });
    s.querySelector('.requeue')?.addEventListener('click', () => this.afterBreak(() => this.quickCrew()));
    s.querySelector('.clip')!.addEventListener('click', () => this.saveClip());
    s.querySelector('.board')?.addEventListener('click', () => this.showBoard());
    s.querySelector('.menu')!.addEventListener('click', () => this.afterBreak(() => {
      this.endSession();
      this.showMenu();
    }));
    const dbl = s.querySelector<HTMLButtonElement>('.double')!;
    dbl.addEventListener('click', async () => {
      dbl.disabled = true;
      const ok = await platform.rewardedBreak();
      if (ok) {
        profile().coins += r.coins;
        saveProfile();
        s.querySelector('.coinval')!.textContent = `+${r.coins * 2}`;
        dbl.textContent = '✔ Doubled!';
        sfx('collect');
      }
    });
  }

  /** Short ad between courses (portal builds only), then continue. */
  private async afterBreak(then: () => void) {
    this.ui.innerHTML = '';
    await platform.commercialBreak();
    then();
  }

  private nextSpec(): CourseSpec | null {
    const sp = this.spec;
    if (!sp || sp.index < 0) return null;
    if (sp.index < 2) return { biome: sp.biome, index: sp.index + 1 };
    const b = BIOME_ORDER.indexOf(sp.biome);
    return b + 1 < BIOME_ORDER.length ? { biome: BIOME_ORDER[b + 1], index: 0 } : null;
  }

  // ------------------------------------------------------------------ online flows

  private leaveNet() {
    if (this.net) {
      this.net.send({ t: 'leave' });
      this.net.close();
    }
    this.net = null;
    this.lobby = null;
  }

  private async connect(): Promise<boolean> {
    if (this.net && !this.net.closed) return true;
    const net = new Net();
    const ok = await net.connect();
    if (!ok) {
      if (net.lastError) this.toast(net.lastError);
      net.close();
      return false;
    }
    this.net = net;
    net.on((m) => this.onNet(m));
    net.onClose = () => {
      if (this.net !== net) return;
      this.net = null;
      if (this.session?.online) {
        this.toast('Lost connection to the server.');
        this.endSession();
        this.showMenu();
      }
    };
    return true;
  }

  private onNet(m: ServerMsg) {
    switch (m.t) {
      case 'lobby':
        this.lobby = m.lobby;
        if (m.lobby.state === 'lobby' && !this.session?.online) this.showLobby(m.lobby);
        break;
      case 'start':
        this.startOnline(m);
        break;
      case 'kicked':
        this.toast(m.reason);
        this.endSession();
        this.leaveNet();
        this.showMenu();
        break;
      case 'error':
        this.toast(m.msg);
        break;
      case 'votekick':
        this.toast(`Vote to remove ${m.target}: ${m.votes}/${m.needed}`);
        break;
      default:
        break;
    }
  }

  async quickCrew() {
    const s = this.screen(`<div class="panel center"><h2>Finding a crew…</h2><div class="spinner"></div><p class="status">Connecting</p><button class="cancel">Cancel</button></div>`);
    let cancelled = false;
    s.querySelector('.cancel')!.addEventListener('click', () => {
      cancelled = true;
      this.showMenu();
    });
    const ok = await this.connect();
    if (cancelled) return;
    if (!ok) {
      // No server (offline build or blocked network): straight into a crew of bots.
      this.toast('Playing with bot buddies (no server found)');
      this.startLocal({ biome: 'kitchen', index: this.firstUnfinished() }, 'solo', 1, 2);
      return;
    }
    this.mode = 'quick';
    this.net!.send({ t: 'quick' });
  }

  private firstUnfinished() {
    const p = profile();
    for (let i = 0; i < 3; i++) if (!p.stars[courseId({ biome: 'kitchen', index: i })]) return i;
    return 0;
  }

  showFriends() {
    const s = this.screen(`
      <div class="panel">
        <h2>👯 Friends crew</h2>
        <p>Make a room and send the code or link to your friends. Up to 4 per crew; empty seats get bots.</p>
        <button class="big create">Create a room</button>
        <div class="join"><input class="code" maxlength="4" placeholder="CODE" autocomplete="off" spellcheck="false"><button class="mid joinbtn">Join</button></div>
        <button class="back">← Back</button>
      </div>`);
    const code = s.querySelector<HTMLInputElement>('.code')!;
    code.addEventListener('input', () => (code.value = code.value.toUpperCase().replace(/[^A-Z]/g, '')));
    s.querySelector('.create')!.addEventListener('click', async () => {
      if (!(await this.connect())) return this.toast('Friends crews need the game server.');
      this.mode = 'friends';
      this.net!.send({ t: 'create' });
    });
    s.querySelector('.joinbtn')!.addEventListener('click', () => code.value.length === 4 && this.joinFriends(code.value));
    s.querySelector('.back')!.addEventListener('click', () => this.showMenu());
  }

  private async joinFriends(code: string) {
    if (!(await this.connect())) return this.toast('Friends crews need the game server.');
    this.mode = 'friends';
    this.net!.send({ t: 'join', code });
  }

  private showLobby(l: LobbyState) {
    const myId = this.net?.id || profile().id;
    const host = l.hostId === myId;
    if (l.mode === 'quick') {
      let s = this.ui.querySelector<HTMLElement>('.quick-lobby');
      if (!s) {
        s = this.screen(`<div class="panel center quick-lobby"><h2>Finding a crew…</h2><div class="spinner"></div><ul class="slots"></ul><p class="status"></p><button class="cancel">Cancel</button></div>`);
        s.querySelector('.cancel')!.addEventListener('click', () => this.showMenu());
      }
      s.querySelector('.slots')!.innerHTML = l.members.map((m) => `<li class="${m.bot ? 'bot' : ''}"><span class="dot" style="--c:#${BODY_COLORS[m.look.body].toString(16).padStart(6, '0')}"></span>${esc(m.name)}</li>`).join('');
      s.querySelector('.status')!.textContent = l.startsIn !== null ? `Starting in ${Math.ceil(l.startsIn)}… (bots fill empty seats)` : '';
      return;
    }
    const link = `${location.origin}${location.pathname}?room=${l.code}&ref=${myId}`;
    const options = BIOME_ORDER.flatMap((b) => BIOMES[b].courses.map((c, i) => ({ spec: { biome: b, index: i } as CourseSpec, name: `${BIOMES[b].name}: ${c.name}` })));
    options.push({ spec: dailySpec(), name: `Daily: ${courseName(dailySpec())}` });
    const cur = courseId(l.spec);
    const s = this.screen(`
      <div class="panel">
        <h2>👯 Crew room <span class="roomcode">${l.code}</span></h2>
        <div class="invite"><input readonly value="${esc(link)}"><button class="copy">Copy invite link</button></div>
        <ul class="slots">${[0, 1, 2, 3]
          .map((i) => {
            const m = l.members[i];
            return m
              ? `<li><span class="dot" style="--c:#${BODY_COLORS[m.look.body].toString(16).padStart(6, '0')}"></span>${esc(m.name)}${m.id === l.hostId ? ' 👑' : ''}${m.id === myId ? ' (you)' : ''}</li>`
              : `<li class="empty">Empty seat (bot)</li>`;
          })
          .join('')}</ul>
        <label>Course ${
          host
            ? `<select class="coursesel">${options.map((o) => `<option value='${JSON.stringify(o.spec)}' ${courseId(o.spec) === cur ? 'selected' : ''}>${esc(o.name)}</option>`).join('')}</select>`
            : `<b>${esc(courseName(l.spec))}</b>`
        }</label>
        ${host ? '<button class="big startbtn">Start ▶</button>' : '<p>Waiting for the host to start…</p>'}
        <button class="back">Leave room</button>
      </div>`);
    s.querySelector('.copy')!.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(link);
        this.toast('Invite link copied!');
      } catch {
        s.querySelector<HTMLInputElement>('.invite input')!.select();
      }
    });
    s.querySelector<HTMLSelectElement>('.coursesel')?.addEventListener('change', (e) => this.net?.send({ t: 'course', spec: JSON.parse((e.target as HTMLSelectElement).value) }));
    s.querySelector('.startbtn')?.addEventListener('click', () => this.net?.send({ t: 'start' }));
    s.querySelector('.back')!.addEventListener('click', () => this.showMenu());
  }

  toast(msg: string) {
    const t = el(`<div class="toast">${esc(msg)}</div>`);
    this.toastEl.appendChild(t);
    setTimeout(() => t.classList.add('out'), 2600);
    setTimeout(() => t.remove(), 3200);
  }

  get serverAvailable() {
    return !!serverBase();
  }
}
