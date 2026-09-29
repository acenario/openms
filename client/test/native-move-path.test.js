import { expect, test } from "bun:test";
import {
  RemotePlayerPath,
  interpolateMovePath,
} from "../src/online/remote-player-path.js";

function entry(tick, x, options = {}) {
  return {
    id: "peer",
    kind: "player",
    tick,
    durationMs: 30,
    moveType: 0,
    position: { x, y: 0 },
    velocity: { x: 100, y: 0 },
    action: 1,
    actionStartTick: 0,
    facing: 1,
    foothold: 1,
    playerMotion: { state: "ground", contactLayer: 1, contactGroup: 0 },
    ...options,
  };
}
function path(short = false) {
  return new RemotePlayerPath(entry(0, 0), 0, 0, short);
}

test("players use the recovered 550 ms catch-up threshold by default", () => {
  const movement = new RemotePlayerPath(entry(0, 0), 0, 0);
  movement.append(entry(1, 55, { durationMs: 550 }), 0);
  expect(movement.stepMs).toBe(32);
});

// An independent arithmetic example from 0068b108, with unequal endpoint velocities.
test("native Hermite keeps the previous and next velocity weights in their recovered order", () => {
  const target = { x: 0, y: 0 };
  interpolateMovePath(
    target,
    { x: 0, y: 0, vx: 20, vy: -40 },
    { x: 10, y: 20, vx: 80, vy: 0, durationMs: 100 },
    25,
  );
  expect(target.x).toBeCloseTo(1.46875);
  expect(target.y).toBeCloseTo(2.5625);
  expect(target.vx).toBeCloseTo((1.46875 * 100) / 3);
});

test("receipt cannot advance the actor; exhaustion holds its final position and velocity", () => {
  const motion = path();
  const source = entry(1, 3);
  const original = structuredClone(source);
  motion.append(source, 1000);
  expect(motion.x).toBe(0);
  expect(motion.sample(1030).x).toBe(0);
  expect(motion.sample(1045).x).toBeCloseTo(1.5);
  expect(motion.sample(1060).x).toBe(3);
  expect(motion.sample(90000).x).toBe(3);
  expect(motion.current.vx).toBe(100);
  expect(source).toEqual(original);
});

test("an airborne, climbing or swimming peer never invents missing movement", () => {
  for (const state of ["air", "ladder", "swim", "fly"]) {
    const entity = entry(0, 20, {
      position: { x: 20, y: -100 },
      velocity: { x: 100, y: 670 },
      playerMotion: { state },
    });
    const motion = new RemotePlayerPath(entity, 0, 0);
    expect(motion.sample(30000)).toMatchObject({ x: 20, y: -100 });
  }
});

test("a burst preserves every turn and landing; it does not skip to the newest packet time", () => {
  const motion = path();
  motion.append(entry(1, 3), 0);
  motion.sample(60);
  motion.sample(500);
  for (let tick = 2; tick <= 12; tick++) {
    motion.append(entry(tick, tick <= 6 ? tick * 3 : (12 - tick) * 3), 500);
  }
  expect(motion.x).toBe(3);
  const positions = [];
  for (let now = 510; now <= 1000; now += 15) {
    positions.push(motion.sample(now).x);
  }
  expect(Math.max(...positions)).toBe(18);
  expect(positions.at(-1)).toBe(0);
  for (let i = 1; i < positions.length; i++) {
    expect(Math.abs(positions[i] - positions[i - 1])).toBeLessThanOrEqual(1.6);
  }
});

test("refill preserves the partial element clock and selects 30/32 ms only on receipt", () => {
  for (const short of [false, true]) {
    const motion = path(short);
    const threshold = short ? 550 : 1100;
    motion.append(entry(1, 30, { durationMs: threshold - 1 }), 0);
    expect(motion.stepMs).toBe(30);
    motion.step();
    expect(motion.elapsedMs).toBe(30);
    motion.append(entry(2, 60, { durationMs: 31 }), 30);
    expect(motion.elapsedMs).toBe(30);
    expect(motion.stepMs).toBe(32);
    motion.step();
    expect(motion.elapsedMs).toBe(62);
    expect(motion.stepMs).toBe(32);
    motion.append(entry(3, 61, { durationMs: 1 }), 60);
    expect(motion.stepMs).toBe(30);
  }
});

test("the native long-backlog rule snaps to the tail and copies current into previous", () => {
  for (const short of [false, true]) {
    const motion = path(short);
    const limit = (short ? 550 : 1100) + 5000;
    motion.append(entry(1, 10, { durationMs: limit }), 0);
    expect(motion.backlogSnaps).toBe(0);
    motion.append(entry(2, 900, { durationMs: 1 }), 0);
    expect(motion.backlogSnaps).toBe(1);
    expect(motion.count).toBe(1);
    expect(motion.x).toBe(0);
    expect(motion.sample(30).x).toBe(900);
    expect(motion.previous.x).toBe(900);
    expect(motion.sample(3000).x).toBe(900);
  }
});

test("explicit short teleports snap but large ordinary displacement has no distance snap", () => {
  const motion = path();
  motion.append(entry(1, 400, { durationMs: 600 }), 0);
  motion.sample(30);
  expect(motion.current.x).toBeLessThan(10);
  motion.relocate(10, -50, 40);
  expect(motion.sample(45)).toMatchObject({ x: 10, y: -50 });
  motion.append(entry(2, 15, { moveType: 3, durationMs: 0 }), 45);
  expect(motion.sample(75).x).toBe(15);
  expect(motion.append(entry(1, -999), 100)).toBe(false);
});

test("buffered facing, action and contact travel with the consumed path", () => {
  const motion = path();
  motion.append(entry(1, 3), 0);
  motion.append(
    entry(2, 6, {
      facing: -1,
      action: 2,
      foothold: 2,
      playerMotion: { state: "ladder", contactLayer: 2, contactGroup: 0 },
    }),
    0,
  );
  expect(motion.drawn.action).toBe(1);
  motion.sample(30);
  // Native replay selects the next node's attributes even at t=0 of that node.
  expect(motion.current).toMatchObject({ facing: -1, action: 2, foothold: 2 });
});

test("frame work is bounded and unpaid replay time remains visible as debt", () => {
  const motion = path();
  for (let tick = 1; tick <= 100; tick++) {
    motion.append(entry(tick, tick * 3), 0);
  }
  motion.sample(1000);
  expect(motion.frameDebtMs).toBe(760);
  expect(motion.count).toBeGreaterThan(90);
  motion.sample(1000);
  expect(motion.frameDebtMs).toBe(520);
});

test("a fresh baseline retires prior path and source ticks while an ordinary frame cannot", () => {
  const motion = path();
  motion.append(entry(10, 30, { durationMs: 300 }), 0);
  motion.sample(100);
  motion.observe(entry(50, 100), 50, 100);
  expect(motion.count).toBeGreaterThan(0);
  motion.reset(entry(50, 100), 50, 100);
  expect(motion.streamOwned).toBe(false);
  expect(motion.sample(100)).toMatchObject({ x: 100, y: 0 });
  expect(motion.append(entry(49, -99), 100)).toBe(false);
  motion.append(entry(51, 103), 100);
  expect(motion.sample(160).x).toBe(103);
});

test("capacity overflow is explicit and cannot force every later refill to snap", () => {
  const motion = path();
  for (let tick = 1; tick <= 257; tick++) {
    motion.append(entry(tick, tick, { durationMs: 1 }), 0);
  }
  expect(motion.capacitySnaps).toBe(1);
  expect(motion.sample(30).x).toBe(257);
  motion.append(entry(258, 260), 30);
  expect(motion.sample(60).x).toBe(257);
  expect(motion.sample(75).x).toBeCloseTo(258.5);
});
