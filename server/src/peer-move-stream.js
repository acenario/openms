import { PROTOCOL } from "../../shared/protocol.js";
import { peerMotionEntity } from "./field-views.js";

/** Engineering storage bound. Each retained entry is one exact 30 ms authority sample. */
const CAPACITY = 256;

class PeerMoveQueue {
  constructor(epoch) {
    this.epoch = epoch;
    this.entries = new Array(CAPACITY).fill(null);
    this.head = 0;
    this.count = 0;
    this.signature = null;
    this.relocation = null;
    this.overflows = 0;
  }

  record(actor, tick) {
    const entity = peerMotionEntity(actor);
    const signature = JSON.stringify(entity);
    const relocation = actor.simulation.relocationSequence ?? 0;
    if (signature === this.signature && relocation === this.relocation) return;
    let snap = this.relocation !== null && relocation !== this.relocation;
    this.signature = signature;
    this.relocation = relocation;
    if (snap || this.count === CAPACITY) {
      if (!snap) this.overflows++;
      this.entries.fill(null);
      this.head = this.count = 0;
      snap = true;
    }
    entity.tick = tick;
    entity.durationMs = snap ? 0 : PROTOCOL.TICK_MS;
    entity.moveType = snap ? 3 : 0;
    this.entries[(this.head + this.count) % CAPACITY] = entity;
    this.count++;
  }

  take() {
    if (!this.count) return null;
    const entry = this.entries[this.head];
    this.entries[this.head] = null;
    this.head = (this.head + 1) % CAPACITY;
    this.count--;
    return entry;
  }
}

/** Record all actors before selecting a bounded publication; a crowded field must retain
 * intermediate landing/ladder samples, not replace them with a newer endpoint. */
export function collectPeerMoves(actors, field) {
  for (const actor of actors) {
    if (actor.peerMoveQueue?.epoch !== field.epoch) {
      actor.peerMoveQueue = new PeerMoveQueue(field.epoch);
    }
    actor.peerMoveQueue.record(actor, field.tick);
  }
  const entries = [];
  const rounds = Math.ceil(PROTOCOL.MAX_PEER_MOTIONS / actors.length);
  for (let round = 0; round < rounds; round++) {
    for (let offset = 0; offset < actors.length; offset++) {
      if (entries.length === PROTOCOL.MAX_PEER_MOTIONS) return entries;
      const actor = actors[(field.tick + offset) % actors.length];
      const entry = actor.peerMoveQueue.take();
      if (entry) entries.push(entry);
    }
  }
  return entries;
}
