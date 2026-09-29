import type { CourseSpec, CrewMember, EmoteKind, Look, PingKind, PlayerInput, RunResult, Snapshot } from './types';

export const PROTOCOL_VERSION = 1;

// Client → server
export type ClientMsg =
  | { t: 'hello'; v: number; id: string; name: string; look: Look; stars: number }
  | { t: 'quick' }
  | { t: 'create' }
  | { t: 'join'; code: string }
  | { t: 'leave' }
  | { t: 'course'; spec: CourseSpec } // host only
  | { t: 'start' } // host only
  | { t: 'input'; input: PlayerInput }
  | { t: 'ping'; kind: PingKind; x: number; y: number }
  | { t: 'emote'; kind: EmoteKind }
  | { t: 'chat'; i: number }
  | { t: 'votekick'; target: string }
  | { t: 'report'; target: string; reason: string }
  | { t: 'again' };

// Server → client
export interface LobbyState {
  code: string | null; // null for quick crews
  mode: 'quick' | 'friends';
  hostId: string | null;
  spec: CourseSpec;
  members: CrewMember[];
  startsIn: number | null; // seconds (quick crews)
  state: 'lobby' | 'playing' | 'results';
}

export type ServerMsg =
  | { t: 'welcome'; id: string; online: number }
  | { t: 'lobby'; lobby: LobbyState }
  | { t: 'start'; spec: CourseSpec; slot: number; crew: CrewMember[] }
  | { t: 'crew'; crew: CrewMember[] } // roster changes mid-course (bot swaps)
  | { t: 'snap'; s: Snapshot }
  | { t: 'result'; result: RunResult }
  | { t: 'kicked'; reason: string }
  | { t: 'error'; msg: string }
  | { t: 'votekick'; target: string; votes: number; needed: number };
