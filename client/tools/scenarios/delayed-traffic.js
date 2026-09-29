const MAX_FRAMES = 256;
const MAX_BYTES = 4 * 1024 * 1024;

/** Fixture-only HTTP RTT and FIFO WebSocket delay, applied to real network frames. */
export class DelayedTraffic {
  constructor(roundTripMs) {
    if (
      !Number.isInteger(roundTripMs) ||
      roundTripMs < 0 ||
      roundTripMs > 2000
    ) {
      throw new Error("Fixture RTT must be in 0..2000 milliseconds");
    }
    this.roundTripMs = roundTripMs;
    this.links = new Map();
    this.stalledUntil = { up: 0, down: 0 };
    this.httpRequests = 0;
    this.frames = { up: 0, down: 0 };
    this.lastMotion = null;
  }

  async http() {
    this.httpRequests++;
    await Bun.sleep(this.roundTripMs);
  }

  enqueue(relay, direction, text, send) {
    if (direction === "down") {
      const message = JSON.parse(text);
      if (message.type === "motion") this.lastMotion = message;
    }
    let pair = this.links.get(relay);
    if (!pair) {
      if (this.links.size >= 8) {
        throw new Error("Fixture relay capacity exceeded");
      }
      pair = { up: link("up"), down: link("down") };
      this.links.set(relay, pair);
    }
    const channel = pair[direction];
    const bytes = Buffer.byteLength(text);
    if (
      channel.queue.length >= MAX_FRAMES ||
      channel.bytes + bytes > MAX_BYTES
    ) {
      throw new Error("Fixture delayed traffic exceeds its queue budget");
    }
    this.frames[direction]++;
    channel.queue.push({
      send,
      bytes,
      at: performance.now() + this.roundTripMs / 2,
    });
    channel.bytes += bytes;
    this.schedule(channel);
  }

  schedule(channel) {
    if (channel.timer || !channel.queue.length) return;
    const at = Math.max(
      channel.queue[0].at,
      this.stalledUntil[channel.direction],
    );
    channel.timer = setTimeout(
      () => this.flush(channel),
      Math.max(0, at - performance.now()),
    );
  }

  flush(channel) {
    channel.timer = null;
    const now = performance.now();
    for (let count = 0; count < MAX_FRAMES && channel.queue.length; count++) {
      if (
        Math.max(channel.queue[0].at, this.stalledUntil[channel.direction]) >
        now
      ) {
        break;
      }
      const frame = channel.queue.shift();
      channel.bytes -= frame.bytes;
      frame.send();
    }
    this.schedule(channel);
  }

  stall(milliseconds, direction = "both") {
    if (
      !Number.isInteger(milliseconds) ||
      milliseconds < 0 ||
      milliseconds > 3000
    ) {
      throw new Error("Fixture stall must be in 0..3000 milliseconds");
    }
    if (!["both", "up", "down"].includes(direction)) {
      throw new Error("Unknown traffic direction");
    }
    const until = performance.now() + milliseconds;
    if (direction !== "down") this.stalledUntil.up = until;
    if (direction !== "up") this.stalledUntil.down = until;
  }

  close(relay) {
    const pair = this.links.get(relay);
    if (!pair) return;
    for (const channel of [pair.up, pair.down]) {
      clearTimeout(channel.timer);
      channel.queue.length = 0;
      channel.bytes = 0;
    }
    this.links.delete(relay);
  }
}

function link(direction) {
  return { direction, queue: [], bytes: 0, timer: null };
}
