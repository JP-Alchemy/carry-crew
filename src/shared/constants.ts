export const DT = 1 / 60;
export const GRAVITY = -22;

export const MAX_CREW = 4;

// Bodies
export const PLAYER_R = 0.36;
export const PLAYER_DENSITY = 2.4;
export const MOVE_SPEED = 4.3;
export const CARRY_SPEED = 3.3;
export const GROUND_ACCEL = 38;
export const AIR_ACCEL = 14;
export const JUMP_V = 8.9;
export const COYOTE_TIME = 0.1;
export const JUMP_BUFFER = 0.12;
export const DIVE_IMPULSE_X = 6.5;
export const DIVE_IMPULSE_Y = 2.4;
export const DIVE_TIME = 0.45;
export const DIVE_COOLDOWN = 0.9;
export const GRAB_RADIUS = 0.3;
export const PANIC_RADIUS = 1.7;
export const STAMINA_MAX = 5;
export const REGRAB_COOLDOWN = 0.35;

// Rope
export const ROPE_LEN = 3.0;
export const ROPE_SEG_R = 0.07;
export const ROPE_SEG_SPACING = 0.3;

// Rules
export const CRASH_DV = 4.2; // sudden velocity change (m/s in one step) that starts to hurt cargo
export const DROP_DAMAGE = 12;
export const KILL_GRACE = 0.9; // seconds a player may lie in a kill zone before the crew resets
export const DELIVER_HOLD = 0.6;

// Collision groups: membership in the high 16 bits, filter in the low 16 bits.
export const G_TERRAIN = 1;
export const G_PLAYER = 2;
export const G_ROPE = 4;
export const G_CARGO = 8;
export const G_PROP = 16;
export const groups = (member: number, filter: number) => ((member & 0xffff) << 16) | (filter & 0xffff);
