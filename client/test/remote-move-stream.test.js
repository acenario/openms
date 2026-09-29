import { expect, test } from "bun:test";
import original from "../../docs/ghidra-physics-motion/wz-globals.json";
import {
  createSimulation,
  advanceSimulation,
} from "../src/physics/simulation.js";
import { attachGround, prepareSegments } from "../src/physics/geometry.js";
import { prepareBounds } from "../src/physics/bounds.js";
import { RemotePlayerPath } from "../src/online/remote-player-path.js";
import { OnlineScene } from "../src/online/scene.js";

const TICK_MS = 30;
const FRAME_MS = 15;
/** 500 ms ping is 250 ms per leg; the ack-gated entity frame adds a full round trip on
 *  top, which is why sampled motion must not ride that path. */
const ONE_WAY_MS = 250;

function floor(id, y, [x1, x2], { layer = 1, group = 0 } = {}) {
  return { id, layer, group, x1, y1: y, x2, y2: y, prev: 0, next: 0 };
}

const FOOTHOLDS = [
  floor(1, 0, [-500, 120]),
  floor(2, -200, [150, 600], { layer: 2, group: 3 }),
];
const LADDERS = [
  { id: 1, x: 200, y1: -200, y2: 0, ladder: true, uf: false, page: 1 },
];

function geometry() {
  const result = prepareSegments(FOOTHOLDS.map((entry) => ({ ...entry })));
  result.bounds = prepareBounds(result.segments, { fieldLimit: 0 });
  return result;
}

function held(over = {}) {
  return {
    left: false,
    right: false,
    up: false,
    down: false,
    jump: false,
    attack: false,
    jumpPressed: false,
    ...over,
  };
}

/** A peer that walks to the rope, climbs it, jumps off at the top and lands. */
function script(tick) {
  if (tick < 30) return held({ right: true });
  if (tick === 30) return held({ right: true, jump: true, jumpPressed: true });
  if (tick < 48) return held({ right: true });
  if (tick < 58) return held({ right: true });
  if (tick < 118) return held({ up: true });
  if (tick === 118) return held({ up: true, jump: true, jumpPressed: true });
  return held({ right: true });
}

function playerMotion(sim) {
  const settings = sim.effectiveSettings;
  return {
    state: sim.state,
    gravity: settings.gravityAcc * settings.gravity,
    fallSpeed: settings.fallSpeed * settings.gravity,
    ignoredFoothold: sim.ignoredFootholdId,
    contactLayer: sim.contactLayer,
    contactGroup: sim.contactGroup,
    ladder: sim.ladder
      ? { x: sim.ladder.x, top: sim.ladder.y1, bottom: sim.ladder.y2 }
      : null,
  };
}

function sampleEntity(sim) {
  return {
    id: "peer",
    kind: "player",
    position: { x: sim.x, y: sim.y },
    velocity: { x: sim.vx, y: sim.vy },
    foothold: sim.foothold?.id ?? null,
    facing: sim.facing,
    action: 1,
    actionStartTick: 1,
    combatState: { phase: "idle", phaseMs: 0 },
    playerMotion: playerMotion(sim),
  };
}

/** Produce the peer's own tick trace and the per-tick samples a move packet would carry. */
function peerTrace(ticks) {
  const sim = createSimulation(
    {
      schemaVersion: 1,
      globals: original.globals,
      footholds: FOOTHOLDS.map((entry) => ({ ...entry })),
      ladders: LADDERS.map((entry) => ({ ...entry })),
      map: { fieldLimit: 0 },
    },
    { x: 0, y: 0 },
  );
  attachGround(sim, sim.geometry.byId.get(1));
  sim.x = 0;
  sim.previousX = 0;
  sim.y = 0;
  sim.previousY = 0;
  const trace = [];
  const samples = [];
  for (let tick = 0; tick < ticks; tick++) {
    advanceSimulation(sim, script(tick), TICK_MS);
    trace.push({
      x: sim.x,
      y: sim.y,
      state: sim.state,
      foothold: sim.foothold?.id ?? null,
    });
    samples.push({
      tick: tick + 1,
      at: (tick + 1) * TICK_MS,
      entity: sampleEntity(sim),
    });
  }
  return { trace, samples };
}

function floorYAt(segments, x) {
  let best = null;
  for (const entry of segments) {
    if (x < Math.min(entry.x1, entry.x2) - 1) continue;
    if (x > Math.max(entry.x1, entry.x2) + 1) continue;
    const y =
      entry.y1 +
      ((x - entry.x1) * (entry.y2 - entry.y1)) / (entry.x2 - entry.x1);
    if (best === null || y > best) best = y;
  }
  return best;
}

/** Replay a delivered sample stream with the real client presentation owner. */
function replay(trace, samples, _segments, ticks) {
  const motion = new RemotePlayerPath(samples[0].entity, 0, 0);
  motion.x = samples[0].entity.position.x;
  motion.y = samples[0].entity.position.y;
  let index = 0;
  const frames = [];
  for (let now = 0; now <= ticks * TICK_MS; now += FRAME_MS) {
    while (index < samples.length && samples[index].at + ONE_WAY_MS <= now) {
      const sample = samples[index];
      motion.append(
        {
          ...sample.entity,
          tick: sample.tick,
          durationMs: TICK_MS,
          moveType: 0,
        },
        sample.at + ONE_WAY_MS,
      );
      index++;
    }
    const pose = motion.sample(now);
    const contentMs = now - 60 - ONE_WAY_MS;
    const tick = Math.max(
      0,
      Math.min(trace.length - 1, Math.round(contentMs / TICK_MS)),
    );
    frames.push({
      now,
      contentMs,
      x: pose.x,
      y: pose.y,
      truth: trace[tick],
    });
  }
  return frames;
}

test("a dense move stream keeps a 500 ms peer on the shared physics trajectory", () => {
  const segments = geometry();
  const ticks = 170;
  const { trace, samples } = peerTrace(ticks);
  const frames = replay(trace, samples, segments, ticks);
  let penetration = 0;
  let error = 0;
  let backward = 0;
  let previousX = null;
  for (const frame of frames) {
    // Ignore the buffer fill before the first sample has arrived.
    if (frame.contentMs <= 0) continue;
    const floorY = floorYAt(segments.segments, frame.x);
    if (frame.truth.state === "ground" && floorY !== null) {
      penetration = Math.max(penetration, frame.y - floorY);
      error = Math.max(
        error,
        Math.hypot(frame.x - frame.truth.x, frame.y - frame.truth.y),
      );
    }
    if (previousX !== null) backward = Math.max(backward, previousX - frame.x);
    previousX = frame.x;
  }
  expect(penetration).toBeLessThanOrEqual(0.5);
  expect(error).toBeLessThan(12);
  expect(backward).toBeLessThan(2);
});

test("a rope drop releases with the sampled state instead of floating on the rope", () => {
  const segments = geometry();
  const ticks = 170;
  const { trace, samples } = peerTrace(ticks);
  const frames = replay(trace, samples, segments, ticks);
  // While the true peer is climbing, the drawn peer must stay on the rope line; once it
  // jumps off, the drawn peer must leave the rope within one 30 ms sample.
  let offRopeDuringClimb = 0;
  for (const frame of frames) {
    if (frame.truth.state === "ladder") {
      offRopeDuringClimb = Math.max(
        offRopeDuringClimb,
        Math.abs(frame.x - 200),
      );
    }
  }
  expect(offRopeDuringClimb).toBeLessThan(2);
  const airborne = frames.filter((frame) => frame.truth.state === "air");
  expect(airborne.length).toBeGreaterThan(10);
});

function peerSceneHost() {
  const observed = [];
  const depths = [];
  const view = {
    entity: {
      id: "peer",
      kind: "player",
      position: { x: 10, y: 0 },
      velocity: { x: 0, y: 0 },
      foothold: 1,
      facing: 1,
      action: 1,
      actionStartTick: 1,
      playerMotion: { state: "ground" },
      combatState: { phase: "idle" },
    },
    animation: { actions: new Map(), setTint() {} },
    actionClock: { observe() {} },
    motion: {
      append: (...args) => {
        observed.push(args);
        return true;
      },
    },
    drawX: 10,
    drawY: 0,
  };
  const host = {
    selfId: "self",
    fieldEpoch: "field",
    motionNow: 1000,
    views: new Map([["peer", view]]),
    footholds: new Map([[1, { id: 1, layer: 1, group: 0 }]]),
    updateViewDepth: (entry) => depths.push(entry.entity.id),
  };
  return { host, view, observed, depths };
}

test("the scene applies an un-acked peer sample and keys later frames to its tick", () => {
  const { host, view, observed, depths } = peerSceneHost();
  OnlineScene.prototype.peers.call(host, {
    fieldEpoch: "field",
    tick: 20,
    entries: [
      {
        id: "peer",
        tick: 20,
        durationMs: 30,
        moveType: 0,
        position: { x: 50, y: -10 },
        velocity: { x: 125, y: -100 },
        foothold: null,
        facing: 1,
        action: 2,
        actionStartTick: 20,
        playerMotion: { state: "air" },
      },
      // An unknown id must not create a view or throw.
      { id: "ghost", position: { x: 0, y: 0 }, playerMotion: { state: "air" } },
    ],
  });
  expect(observed.length).toBe(1);
  const [entity, time] = observed[0];
  expect(entity.position).toEqual({ x: 50, y: -10 });
  expect(entity.tick).toBe(20);
  // Receipt supplies the current clock, never a synthetic packet timestamp.
  expect(time).toBe(1000);
  expect(view.motionTick).toBe(20);
  expect(view.drawX).toBe(10);
  expect(host.views.has("ghost")).toBe(false);
  expect(depths).toEqual([]);
});

test("a peer sample from a retired field is ignored outright", () => {
  const { host, observed } = peerSceneHost();
  OnlineScene.prototype.peers.call(host, {
    fieldEpoch: "other",
    tick: 21,
    entries: [
      {
        id: "peer",
        tick: 20,
        durationMs: 30,
        moveType: 0,
        position: { x: 90, y: 0 },
        velocity: { x: 0, y: 0 },
        foothold: 1,
        facing: 1,
        action: 1,
        actionStartTick: 1,
        playerMotion: { state: "ground" },
      },
    ],
  });
  expect(observed.length).toBe(0);
});

/** The server freezes a preparing actor in createSimulation's initial airborne state. */
function loadingPeer(x = 0, y = -100) {
  return {
    id: "peer",
    kind: "player",
    position: { x, y },
    velocity: { x: 0, y: 0 },
    foothold: null,
    facing: 1,
    action: 1,
    actionStartTick: 1,
    combatState: { phase: "idle", phaseMs: 0 },
    playerMotion: {
      state: "air",
      gravity: 2000,
      fallSpeed: 670,
      ignoredFoothold: 0,
      contactLayer: 7,
      contactGroup: 0,
      ladder: null,
    },
  };
}

test("a still-loading peer holds its spawn instead of dropping once per round trip", () => {
  // The ordered state frame alone must not arm the free-fall forecast.
  const motion = new RemotePlayerPath(loadingPeer(), -1, 0);
  let tick = 1;
  let lowest = -Infinity;
  for (let now = 0; now <= 4000; now += 15) {
    // One ack-gated state frame per 500 ms round trip, all identical.
    if (now % 500 === 0) motion.observe(loadingPeer(), tick++, now, null);
    lowest = Math.max(lowest, motion.sample(now).y);
  }
  expect(motion.count).toBe(0);
  // Never more than a rounding error below the frozen spawn, at any latency.
  expect(lowest).toBeLessThanOrEqual(-100 + 0.01);
});

test("the first move sample owns the path and later membership frames cannot replay it", () => {
  const { host, view } = peerSceneHost();
  view.motion = new RemotePlayerPath(loadingPeer(), -1, 0);
  const entry = {
    ...loadingPeer(10),
    tick: 20,
    durationMs: 30,
    moveType: 0,
  };
  OnlineScene.prototype.peers.call(host, {
    fieldEpoch: "field",
    tick: 20,
    entries: [entry],
  });
  expect(view.motion.streamOwned).toBe(true);
  view.motion.observe(loadingPeer(999), 30, 1000);
  expect(view.motion.count).toBe(1);
  expect(view.motion.tick).toBe(20);
  view.motion.sample(1060);
  expect(view.motion.x).toBe(10);
});

test("scene baseline resets reused peer playback and a delayed teleport event cannot flush it", () => {
  const { host, view } = peerSceneHost();
  view.motion = new RemotePlayerPath(loadingPeer(), 0, 0);
  view.motion.append(
    { ...loadingPeer(20), tick: 1, durationMs: 30, moveType: 0 },
    0,
  );
  view.motionTick = 1;
  host.tick = 50;
  OnlineScene.prototype.resetPeerPath.call(host, loadingPeer(90));
  expect(view.motionTick).toBeUndefined();
  expect(view.motion.sample(host.motionNow)).toMatchObject({ x: 90, y: -100 });
  view.motion.append(
    { ...loadingPeer(100), tick: 51, durationMs: 30, moveType: 0 },
    host.motionNow,
  );
  OnlineScene.prototype.relocateObserved.call(host, {
    actorId: "peer",
    destination: { x: -10, y: 0 },
  });
  expect(view.motion.count).toBe(1);
  expect(view.motion.sample(host.motionNow + 60).x).toBe(100);
});
