import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { appendFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Buffered JSON-lines appender: lines are batched and written at most once per `flushMs`. */
export class JsonlWriter {
  private buf: string[] = [];
  private timer: NodeJS.Timeout | null = null;
  private chain: Promise<void> = Promise.resolve();
  constructor(
    readonly file: string,
    private flushMs = 1000,
  ) {}

  push(obj: unknown) {
    this.buf.push(JSON.stringify(obj));
    if (!this.timer) {
      this.timer = setTimeout(() => void this.flush(), this.flushMs);
      this.timer.unref();
    }
  }

  flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.buf.length) return this.chain;
    const data = this.buf.join('\n') + '\n';
    this.buf = [];
    this.chain = this.chain.then(() => appendFile(this.file, data).catch((e) => console.error(`[store] append ${this.file} failed:`, e)));
    return this.chain;
  }

  /** Synchronous last-chance flush (process exit). */
  flushSync() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.buf.length) return;
    try {
      appendFileSync(this.file, this.buf.join('\n') + '\n');
    } catch (e) {
      console.error(`[store] append ${this.file} failed:`, e);
    }
    this.buf = [];
  }
}

/** A JSON document persisted with debounced, atomic (tmp + rename) writes. */
export class JsonDoc<T> {
  data: T;
  private timer: NodeJS.Timeout | null = null;
  private chain: Promise<void> = Promise.resolve();
  constructor(
    readonly file: string,
    init: () => T,
    private debounceMs = 2000,
  ) {
    let data: T;
    try {
      data = JSON.parse(readFileSync(file, 'utf8')) as T;
    } catch {
      data = init();
    }
    this.data = data;
  }

  changed() {
    if (this.timer) return;
    this.timer = setTimeout(() => void this.save(), this.debounceMs);
    this.timer.unref();
  }

  save(): Promise<void> {
    if (!this.timer) return this.chain;
    clearTimeout(this.timer);
    this.timer = null;
    const text = JSON.stringify(this.data);
    const tmp = this.file + '.tmp';
    this.chain = this.chain.then(() =>
      writeFile(tmp, text)
        .then(() => rename(tmp, this.file))
        .catch((e) => console.error(`[store] write ${this.file} failed:`, e)),
    );
    return this.chain;
  }

  saveSync() {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
    try {
      const tmp = this.file + '.tmp';
      writeFileSync(tmp, JSON.stringify(this.data));
      renameSync(tmp, this.file);
    } catch (e) {
      console.error(`[store] write ${this.file} failed:`, e);
    }
  }
}

export interface BoardEntry {
  crew: string[];
  stars: number;
  time: number;
  damage: number;
  at: number;
}

export interface InviteData {
  /** new player id → id of the player who invited them */
  credited: Record<string, string>;
  /** inviter id → number of friends credited */
  counts: Record<string, number>;
}

const BOARD_SIZE = 100;
const MAX_BOARD_KEYS = 40;

export class Store {
  readonly analytics: JsonlWriter;
  readonly reports: JsonlWriter;
  readonly board: JsonDoc<Record<string, BoardEntry[]>>;
  readonly invites: JsonDoc<InviteData>;

  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true });
    this.analytics = new JsonlWriter(join(dir, 'analytics.jsonl'));
    this.reports = new JsonlWriter(join(dir, 'reports.jsonl'), 200);
    this.board = new JsonDoc(join(dir, 'leaderboard.json'), () => ({}));
    this.invites = new JsonDoc(join(dir, 'invites.json'), () => ({ credited: {}, counts: {} }));
    if (!this.invites.data.credited || !this.invites.data.counts) this.invites.data = { credited: {}, counts: {} };
  }

  /** Insert a run; returns its 1-based rank, or 0 if it didn't make the top 100. */
  submitRun(key: string, e: BoardEntry): number {
    const b = this.board.data;
    let list = b[key];
    if (!list) {
      list = b[key] = [];
      const keys = Object.keys(b);
      // Old days/weeks fall off once there are plenty of newer boards.
      if (keys.length > MAX_BOARD_KEYS) for (const k of keys.slice(0, keys.length - MAX_BOARD_KEYS)) delete b[k];
    }
    list.push(e);
    list.sort((x, y) => y.stars - x.stars || x.damage - y.damage || x.time - y.time || x.at - y.at);
    const rank = list.indexOf(e) + 1;
    if (list.length > BOARD_SIZE) list.length = BOARD_SIZE;
    this.board.changed();
    return rank <= BOARD_SIZE ? rank : 0;
  }

  topRuns(key: string, n = 50): Omit<BoardEntry, 'at'>[] {
    return (this.board.data[key] ?? []).slice(0, n).map(({ crew, stars, time, damage }) => ({ crew, stars, time, damage }));
  }

  /** Returns false if `id` had already been credited to someone. */
  creditInvite(ref: string, id: string): boolean {
    const inv = this.invites.data;
    if (Object.prototype.hasOwnProperty.call(inv.credited, id)) return false;
    inv.credited[id] = ref;
    inv.counts[ref] = (inv.counts[ref] ?? 0) + 1;
    this.invites.changed();
    return true;
  }

  inviteCount(id: string): number {
    return Object.prototype.hasOwnProperty.call(this.invites.data.counts, id) ? this.invites.data.counts[id] : 0;
  }

  async flush() {
    await Promise.all([this.analytics.flush(), this.reports.flush(), this.board.save(), this.invites.save()]);
  }

  flushSync() {
    this.analytics.flushSync();
    this.reports.flushSync();
    this.board.saveSync();
    this.invites.saveSync();
  }
}
