import { PROTOCOL } from "../../../shared/protocol.js";

function entry() {
  return {
    inputSeq: 0,
    targetTick: 0,
    motionEpoch: 0,
    motionConfig: 0,
    movementLocked: false,
    impulses: [],
    horizontal: 0,
    vertical: 0,
    jump: false,
    attack: false,
    motion: null,
    point: { x: 0, y: 0, vx: 0, vy: 0 },
  };
}

/** Unsent input has a local identity even while the socket is backpressured.
 * Fixed capacity; never overwrite an unacknowledged press/release edge. */
export class InputJournal {
  constructor() {
    this.entries = Array.from({ length: PROTOCOL.INPUT_HISTORY }, entry);
    this.clear();
  }
  clear() {
    this.head = 0;
    this.count = 0;
  }
  push(sample, inputSeq) {
    if (this.count === this.entries.length) return false;
    const next = this.entries[(this.head + this.count) % this.entries.length];
    next.inputSeq = inputSeq;
    next.targetTick = sample.targetTick;
    next.motionEpoch = sample.motionEpoch;
    next.motionConfig = sample.motionConfig;
    next.movementLocked = sample.movementLocked;
    next.impulses.length = 0;
    for (const impulse of sample.impulses) next.impulses.push(impulse);
    next.horizontal = sample.horizontal;
    next.vertical = sample.vertical;
    next.jump = sample.jump;
    next.attack = sample.attack;
    next.motion = sample.motion ? next.point : null;
    if (sample.motion) Object.assign(next.point, sample.motion);
    this.count++;
    return true;
  }
  first() {
    return this.count ? this.entries[this.head] : null;
  }
  shift() {
    if (!this.count) return;
    this.head = (this.head + 1) % this.entries.length;
    this.count--;
  }
}
