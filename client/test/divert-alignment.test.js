import { test, expect } from "bun:test";
import original from "../../docs/ghidra-physics-motion/wz-globals.json";
import {
  createSimulation,
  applyExternalImpulse,
} from "../src/physics/simulation.js";
import { OnlinePrediction } from "../src/online/prediction.js";
import {
  createHeldInput,
  assignHeldInput,
  stepMotion,
  captureMotion,
  restoreMotion,
} from "../../shared/motion.js";

/** Synthetic isolating geometry, not an original-game recording. Mirrors the
 *  sync-alignment suite so both exercise the same online continuation boundary. */
function world() {
  return {
    schemaVersion: 1,
    globals: original.globals,
    map: {},
    ladders: [],
    footholds: [
      {
        id: 1,
        layer: 1,
        group: 0,
        x1: -1000,
        y1: 0,
        x2: 1000,
        y2: 0,
        prev: 0,
        next: 0,
        properties: {},
      },
      {
        id: 2,
        layer: 1,
        group: 0,
        x1: -1000,
        y1: 300,
        x2: 1000,
        y2: 300,
        prev: 0,
        next: 0,
        properties: {},
      },
    ],
  };
}

function sample(tick) {
  return {
    horizontal: tick < 25 ? 1 : tick < 50 ? -1 : 0,
    vertical: 0,
    jump: tick === 12,
    attack: false,
  };
}

/** Client prediction advanced `lastTick` ticks through the real predictor boundary. */
function predicting(lastTick) {
  const simulation = createSimulation(world(), { x: 0, y: -10 });
  let seq = 0;
  const sent = [];
  const prediction = new OnlinePrediction({
    onInput(value) {
      sent.push({ ...value, motion: { ...value.motion } });
      seq++;
      return seq;
    },
  });
  prediction.install(simulation, 0);
  // One authenticated checkpoint first: only an already-presented pose is glided.
  prediction.observe({
    connectionEpoch: "epoch",
    fieldEpoch: "field",
    serverTick: 0,
    motionEpoch: 1,
    motionConfig: 1,
    motionTick: 0,
    ackInputSeq: null,
    paused: false,
    motion: captureMotion(simulation),
    authoritative: true,
    diverts: [],
  });
  const held = createHeldInput();
  for (let tick = 1; tick <= lastTick; tick++) {
    assignHeldInput(held, sample(tick));
    expect(prediction.predict(held, true)).toBe(true);
  }
  return { prediction, simulation, sent };
}

function checkpoint(simulation, tick, diverts = [], authoritative = false) {
  return {
    connectionEpoch: "epoch",
    fieldEpoch: "field",
    serverTick: tick,
    motionEpoch: 1,
    motionConfig: 1,
    motionTick: tick,
    ackInputSeq: tick,
    paused: false,
    motion: captureMotion(simulation),
    authoritative,
    diverts,
  };
}

test("a reported sample carries its completed endpoint, bounded and normalized", () => {
  const { prediction, sent } = predicting(3);
  expect(sent).toHaveLength(3);
  for (let tick = 1; tick <= 3; tick++) {
    expect(Object.keys(sent[tick - 1]).sort()).toEqual([
      "attack",
      "horizontal",
      "impulses",
      "jump",
      "motion",
      "motionConfig",
      "motionEpoch",
      "movementLocked",
      "targetTick",
      "vertical",
    ]);
    expect(sent[tick - 1].targetTick).toBe(tick);
    for (const value of Object.values(sent[tick - 1].motion)) {
      expect(Number.isFinite(value)).toBe(true);
      expect(Object.is(value, -0)).toBe(false);
    }
  }
  const current = captureMotion(prediction.simulation);
  expect(sent.at(-1).motion.x).toBe(current.x);
  expect(sent.at(-1).motion.y).toBe(current.y);
  expect(prediction.resumeMotion()).toEqual({
    x: current.x,
    y: current.y,
    vx: current.vx,
    vy: current.vy,
  });
});

test("ordinary acknowledgements cannot replace position, inputs or the local clock", () => {
  const { prediction, simulation } = predicting(8);
  const before = captureMotion(simulation);
  const server = createSimulation(world(), { x: 500, y: -10 });
  server.movementLocked = true;
  prediction.observe(checkpoint(server, 4));
  expect(captureMotion(simulation)).toEqual(before);
  expect(prediction.predictedTick).toBe(8);
  expect(prediction.count).toBe(4);
  expect(prediction.snapshot().corrections).toBe(0);
  expect(prediction.snapshot().replayedTicks).toBe(0);
});

test("an authoritative checkpoint replaces the local kernel exactly", () => {
  const { prediction, simulation } = predicting(8);
  const server = createSimulation(world(), { x: 24, y: -10 });
  // At the predicted tick there is no unacknowledged suffix: adoption is exact.
  prediction.observe(checkpoint(server, 8, [], true));
  expect(simulation.x).toBe(24);
  expect(captureMotion(simulation)).toEqual(captureMotion(server));
});

test("a confirmed knockback merges into the current path without replay or position change", () => {
  const { prediction, simulation } = predicting(8);
  const reference = createSimulation(world(), { x: 0, y: -10 });
  restoreMotion(reference, captureMotion(simulation));
  const beforeX = simulation.x;
  applyExternalImpulse(reference, 270, -270);
  prediction.observe(
    checkpoint(predicting(4).simulation, 4, [
      { id: 1, tick: 4, vx: 270, vy: -270, source: "hit", skillId: 0 },
    ]),
  );
  expect(simulation.x).toBe(beforeX);
  expect(captureMotion(simulation)).toEqual(captureMotion(reference));
  expect(prediction.snapshot().diverts).toBe(1);
  expect(prediction.snapshot().corrections).toBe(0);
});

test("an optimistic movement skill is applied once and its divert is retired", () => {
  const { prediction, simulation } = predicting(6);
  const token = prediction.beginOptimistic(
    { kind: "impulse", vx: 350, vy: -250 },
    4111006,
  );
  expect(token).not.toBeNull();
  expect(simulation.vx).toBeCloseTo(350, 8);
  expect(simulation.vy).toBeCloseTo(-250, 8);
  expect(prediction.snapshot().pendingImpulses).toBe(1);
  // The authority publishes the same skill impulse; it must not be merged a second time.
  const before = { vx: simulation.vx, vy: simulation.vy };
  prediction.observe(
    checkpoint(simulation, 7, [
      { id: 1, tick: 7, vx: 350, vy: -250, source: "skill", skillId: 4111006 },
    ]),
  );
  expect(simulation.vx).toBeCloseTo(before.vx, 8);
  expect(simulation.vy).toBeCloseTo(before.vy, 8);
  expect(prediction.snapshot().pendingImpulses).toBe(0);
  // The retired impulse is counted as announced, not as a correction.
  expect(prediction.snapshot().diverts).toBe(0);
});

test("a skill divert the client did not predict is merged", () => {
  const { prediction, simulation } = predicting(6);
  prediction.observe(
    checkpoint(simulation, 7, [
      { id: 1, tick: 7, vx: -200, vy: -180, source: "skill", skillId: 5201006 },
    ]),
  );
  expect(prediction.snapshot().diverts).toBe(1);
});

test("a refused optimistic cast restores the exact pre-cast checkpoint", () => {
  const { prediction, simulation } = predicting(6);
  const before = captureMotion(simulation);
  const token = prediction.beginOptimistic(
    { kind: "impulse", vx: 350, vy: -250 },
    4111006,
  );
  expect(captureMotion(simulation)).not.toEqual(before);
  prediction.rejectOptimistic(token);
  expect(captureMotion(simulation)).toEqual(before);
  expect(prediction.snapshot().pendingImpulses).toBe(0);
});

test("a matching older acknowledgement retires history and leaves the current pose unchanged", () => {
  const { prediction, simulation, sent } = predicting(8);
  const before = captureMotion(simulation);
  const server = predicting(4).simulation;
  prediction.observe(checkpoint(server, 4));
  expect(prediction.snapshot().diverts).toBe(0);
  expect(captureMotion(simulation)).toEqual(before);
  expect(sent).toHaveLength(8);
});

test("local simulation advances even when transport cannot send", () => {
  const { prediction, simulation } = predicting(8);
  prediction.onInput = () => null;
  const x = simulation.x;
  const held = createHeldInput();
  held.right = true;
  expect(prediction.predict(held, true)).toBe(true);
  expect(simulation.x).toBeGreaterThan(x);
});

test("the same history and impulses reproduce captureMotion exactly, once", () => {
  function run() {
    const simulation = createSimulation(world(), { x: 0, y: -10 });
    const prediction = new OnlinePrediction({ onInput: () => 1 });
    prediction.install(simulation, 0);
    prediction.beginOptimistic({ kind: "impulse", vx: 400, vy: -250 }, 4111006);
    const held = createHeldInput();
    expect(prediction.predict(held, true)).toBe(true);
    assignHeldInput(held, {
      horizontal: 1,
      vertical: 0,
      jump: false,
      attack: false,
    });
    expect(prediction.predict(held, true)).toBe(true);
    return captureMotion(simulation);
  }
  const first = run();
  expect(run()).toEqual(first);
  // One merge, not two: the optimistic impulse is applied immediately, not per tick.
  const reference = createSimulation(world(), { x: 0, y: -10 });
  applyExternalImpulse(reference, 400, -250);
  const input = createHeldInput();
  stepMotion(reference, input);
  assignHeldInput(input, {
    horizontal: 1,
    vertical: 0,
    jump: false,
    attack: false,
  });
  stepMotion(reference, input);
  expect(first).toEqual(captureMotion(reference));
});
