/** Recovered from 0068adcc/0068b108/0068b371 in the supplied executable.
 * See docs/native-lag-handling.md. Limits on storage/work are OpenMS policy. */
const QUANTUM_MS = 30;
const FAST_STEP_MS = 32;
const BACKLOG_GRACE_MS = 5000;
const CAPACITY = 256;
const MAX_FRAME_STEPS = 8;

function pose() {
  return {
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    facing: 1,
    action: 0,
    actionStartTick: 0,
    foothold: null,
    playerMotion: null,
    durationMs: 0,
    moveType: 0,
  };
}

function copyEntity(target, entity) {
  target.x = entity.position.x;
  target.y = entity.position.y;
  target.vx = entity.velocity.x;
  target.vy = entity.velocity.y;
  target.facing = entity.facing;
  target.action = entity.action;
  target.actionStartTick = entity.actionStartTick;
  target.foothold = entity.foothold;
  target.playerMotion = entity.playerMotion;
}

function copyPose(target, source) {
  target.x = source.x;
  target.y = source.y;
  target.vx = source.vx;
  target.vy = source.vy;
  copyAttributes(target, source);
}

function copyAttributes(target, source) {
  target.facing = source.facing;
  target.action = source.action;
  target.actionStartTick = source.actionStartTick;
  target.foothold = source.foothold;
  target.playerMotion = source.playerMotion;
}

/** Hermite weights from 0068b108; elapsed is milliseconds, velocities pixels/second. */
export function interpolateMovePath(target, before, after, elapsed) {
  const t = elapsed / after.durationMs;
  const t2 = t * t;
  const next = 3 * t2 - 2 * t2 * t;
  const previousVelocity = (elapsed / 1000) * (t2 - 2 * t + 1);
  const nextVelocity = (elapsed / 1000) * (t2 - t);
  const x =
    before.x * (1 - next) +
    after.x * next +
    before.vx * previousVelocity +
    after.vx * nextVelocity;
  const y =
    before.y * (1 - next) +
    after.y * next +
    before.vy * previousVelocity +
    after.vy * nextVelocity;
  target.vx = (x - target.x) * (100 / 3);
  target.vy = (y - target.y) * (100 / 3);
  target.x = x;
  target.y = y;
  copyAttributes(target, after);
}

/** Duration-driven remote character replay. Receipt appends; only the render scheduler
 * steps. No velocity forecast, distance-based snap, or packet-arrival playout clock. */
export class RemotePlayerPath {
  // Player owner type is zero (004b237c), selecting the 500 * 1.1 branch.
  constructor(entity, tick, now, shortPath = true) {
    this.samples = Array.from({ length: CAPACITY }, pose);
    this.anchor = pose();
    this.current = pose();
    this.previous = pose();
    this.drawn = pose();
    this.head = 0;
    this.count = 0;
    this.elapsedMs = 0;
    this.remainingMs = 0;
    this.stepMs = QUANTUM_MS;
    this.thresholdMs = Math.trunc((shortPath ? 500 : 1000) * 1.1);
    this.frameDebtMs = 0;
    this.lastAt = now;
    this.tick = tick;
    this.backlogSnaps = 0;
    this.capacitySnaps = 0;
    this.streamOwned = false;
    this.install(entity);
  }

  /** A new connection baseline replaces the old path even if no later movement follows. */
  reset(entity, tick, now) {
    this.clear();
    this.streamOwned = false;
    this.tick = tick;
    this.lastAt = now;
    this.frameDebtMs = 0;
    this.stepMs = QUANTUM_MS;
    this.install(entity);
  }

  install(entity) {
    copyEntity(this.anchor, entity);
    copyPose(this.current, this.anchor);
    copyPose(this.previous, this.anchor);
    copyPose(this.drawn, this.anchor);
    this.x = this.anchor.x;
    this.y = this.anchor.y;
  }

  /** Ordered membership frames seed only; once the move stream owns us they cannot
   * insert a second copy or jump ahead of a path delayed in transit. */
  observe(entity, tick, now) {
    if (this.streamOwned || tick <= this.tick) return;
    this.tick = tick;
    this.lastAt = now;
    this.install(entity);
  }

  /** Validated OpenMS peer entry: independent source tick, duration and explicit snap. */
  append(entry, now) {
    if (entry.tick <= this.tick) return false;
    this.tick = entry.tick;
    this.streamOwned = true;
    if (this.count === 0) this.lastAt = now;
    const overflow = this.count === CAPACITY;
    if (overflow) {
      this.clear();
      this.capacitySnaps++;
    }
    const sample = this.samples[(this.head + this.count) % CAPACITY];
    copyEntity(sample, entry);
    sample.durationMs = entry.durationMs;
    sample.moveType = entry.moveType;
    this.count++;
    this.remainingMs += sample.durationMs;
    this.stepMs =
      this.remainingMs >= this.thresholdMs ? FAST_STEP_MS : QUANTUM_MS;
    if (this.remainingMs > this.thresholdMs + BACKLOG_GRACE_MS) {
      // 0068b486 reads list +0x20 (tail), not +0x1c (front): snap to NEWEST.
      this.head = (this.head + this.count - 1) % CAPACITY;
      this.count = 1;
      this.remainingMs = 0;
      sample.durationMs = 0;
      sample.moveType = 3;
      this.backlogSnaps++;
    } else if (overflow) {
      this.remainingMs = 0;
      sample.durationMs = 0;
      sample.moveType = 3;
    }
    return true;
  }

  clear() {
    this.head = 0;
    this.count = 0;
    this.elapsedMs = 0;
    this.remainingMs = 0;
  }

  /** Explicit field/portal relocation is immediate and retires the old path. */
  relocate(x, y, now) {
    this.clear();
    this.frameDebtMs = 0;
    this.lastAt = now;
    this.current.x = x;
    this.current.y = y;
    this.current.vx = this.current.vy = 0;
    this.current.foothold = null;
    copyPose(this.anchor, this.current);
    copyPose(this.previous, this.current);
    copyPose(this.drawn, this.current);
    this.x = x;
    this.y = y;
  }

  /** One recovered replay call: consume elapsed nodes, then evaluate the next node. */
  step() {
    copyPose(this.previous, this.current);
    if (!this.count) return;
    this.elapsedMs += this.stepMs;
    let snapped = false;
    for (let consumed = 0; consumed < CAPACITY && this.count; consumed++) {
      const next = this.samples[this.head];
      snapped ||= next.moveType === 3;
      if (this.elapsedMs < next.durationMs) break;
      this.elapsedMs -= next.durationMs;
      copyPose(this.anchor, next);
      copyPose(this.current, next);
      this.head = (this.head + 1) % CAPACITY;
      this.count--;
    }
    this.remainingMs -= this.stepMs;
    if (!this.count || this.remainingMs <= 0) this.clear();
    else {
      const next = this.samples[this.head];
      if (next.moveType === 3) copyPose(this.current, next);
      else interpolateMovePath(this.current, this.anchor, next, this.elapsedMs);
    }
    // 009b17ec: move-type bit 3 copies current to previous, bypassing interpolation.
    if (snapped) copyPose(this.previous, this.current);
  }

  snapshot() {
    return {
      tick: this.tick,
      queued: this.count,
      remainingMs: this.remainingMs,
      stepMs: this.stepMs,
      frameDebtMs: this.frameDebtMs,
      backlogSnaps: this.backlogSnaps,
      capacitySnaps: this.capacitySnaps,
    };
  }

  /** Browser adaptation: fixed 30 ms replay calls, then one-quantum render interpolation.
   * Bounded catch-up retains debt while a path exists; an empty path only holds. */
  sample(now) {
    this.frameDebtMs += Math.max(0, now - this.lastAt);
    this.lastAt = now;
    for (let steps = 0; steps < MAX_FRAME_STEPS; steps++) {
      if (this.frameDebtMs < QUANTUM_MS) break;
      this.frameDebtMs -= QUANTUM_MS;
      this.step();
      if (!this.count && this.frameDebtMs >= QUANTUM_MS) {
        copyPose(this.previous, this.current);
        this.frameDebtMs %= QUANTUM_MS;
        break;
      }
    }
    const alpha = Math.min(1, this.frameDebtMs / QUANTUM_MS);
    this.x = this.previous.x + (this.current.x - this.previous.x) * alpha;
    this.y = this.previous.y + (this.current.y - this.previous.y) * alpha;
    copyPose(this.drawn, this.current);
    this.drawn.x = this.x;
    this.drawn.y = this.y;
    return this.drawn;
  }
}
