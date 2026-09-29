import { test, expect, spyOn } from "bun:test";
import { loadContent } from "../../server/src/content.js";
import { createSimulation } from "../src/physics/simulation.js";
import { OnlinePrediction } from "../src/online/prediction.js";
import { holdObservedClimb, OnlineScene } from "../src/online/scene.js";
import { ServerClock } from "../src/online/transport-clock.js";
import { PROTOCOL } from "../../shared/protocol.js";
import {
  createHeldInput,
  assignHeldInput,
  stepMotion,
  captureMotion,
  restoreMotion,
} from "../../shared/motion.js";

// Reuse the verified extracted physics; this checkout need not retain archived Ghidra JSON.
const content = await loadContent();
const original = {
  globals: (await content.map(content.catalog.defaultMap)).physics.globals,
};

// Synthetic isolating geometry, not an original-game recording. Exercise the real
// online continuation boundary rather than reconstructing state by replaying spawn.
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
    vertical: tick >= 55 && tick < 60 ? 1 : 0,
    jump: tick === 12 || (tick >= 55 && tick < 59),
    attack: false,
  };
}
function run(simulation, input, first, last) {
  for (let tick = first; tick <= last; tick++) {
    assignHeldInput(input, sample(tick));
    stepMotion(simulation, input);
  }
}

test("observed ladder and rope frames advance only while vertical position changes", () => {
  for (const action of ["ladder", "rope", "ladder2", "rope2"]) {
    expect(holdObservedClimb(action, 120, 120)).toBe(true);
    expect(holdObservedClimb(action, 120, 117)).toBe(false);
    expect(holdObservedClimb(action, 120, 123)).toBe(false);
  }
  expect(holdObservedClimb("walk1", 120, 120)).toBe(false);
});

test("mid-flight authoritative checkpoint restores future movement and held edges exactly", () => {
  const source = createSimulation(world(), { x: 0, y: -10 });
  const input = createHeldInput();
  run(source, input, 0, 17);
  const checkpoint = captureMotion(source);
  expect(checkpoint.y).toBeLessThan(0);
  const restored = createSimulation(world(), { x: -900, y: 290 });
  restoreMotion(restored, structuredClone(checkpoint));
  const replay = createHeldInput();
  assignHeldInput(replay, checkpoint.held);
  run(source, input, 18, 110);
  run(restored, replay, 18, 110);
  expect(captureMotion(restored)).toEqual(captureMotion(source));
});

test("down-jump ignored foothold survives a received checkpoint", () => {
  const source = createSimulation(world(), { x: 0, y: -10 });
  const input = createHeldInput();
  assignHeldInput(input, {
    horizontal: 0,
    vertical: 0,
    jump: false,
    attack: false,
  });
  for (let tick = 0; tick < 20; tick++) stepMotion(source, input);
  assignHeldInput(input, {
    horizontal: 0,
    vertical: 1,
    jump: true,
    attack: false,
  });
  stepMotion(source, input);
  const checkpoint = captureMotion(source);
  expect(checkpoint.ignoredFootholdId).toBe(1);
  const restored = createSimulation(world(), { x: 0, y: -10 });
  restoreMotion(restored, checkpoint);
  const replay = createHeldInput();
  assignHeldInput(replay, checkpoint.held);
  for (let tick = 0; tick < 30; tick++) {
    assignHeldInput(input, {
      horizontal: 0,
      vertical: 0,
      jump: false,
      attack: false,
    });
    assignHeldInput(replay, {
      horizontal: 0,
      vertical: 0,
      jump: false,
      attack: false,
    });
    stepMotion(source, input);
    stepMotion(restored, replay);
  }
  expect(restored.footholdId).toBe(2);
  expect(captureMotion(restored)).toEqual(captureMotion(source));
});

test("unknown checkpoint geometry fails before replacing the last complete state", () => {
  const simulation = createSimulation(world(), { x: 0, y: -10 });
  const before = captureMotion(simulation);
  const malformed = structuredClone(before);
  malformed.ignoredFootholdId = 99;
  expect(() => restoreMotion(simulation, malformed)).toThrow(
    "CONTENT_MISMATCH",
  );
  expect(captureMotion(simulation)).toEqual(before);
});

/** Drive the real predictor through one authenticated checkpoint and its bounded catch-up steps. */
function presentable(onGroundJump) {
  const simulation = createSimulation(world(), { x: 0, y: -10 });
  const input = createHeldInput();
  run(simulation, input, 0, 5);
  const prediction = new OnlinePrediction({ onInput: () => 1, onGroundJump });
  prediction.install(simulation, 6);
  prediction.observe({
    connectionEpoch: "epoch",
    fieldEpoch: "field",
    serverTick: 6,
    motionEpoch: 1,
    motionConfig: 1,
    motionTick: 6,
    ackInputSeq: 1,
    paused: false,
    motion: captureMotion(simulation),
  });
  const clock = prediction.lastStepAt;
  prediction.timing({
    ready: true,
    connectionEpoch: "epoch",
    fieldEpoch: "field",
    serverTick: 6,
    roundTripMs: 0,
    oneWayMs: 0,
    offsetMs: 0,
    tickOffsetMs: 6 * PROTOCOL.TICK_MS - clock,
    receivedAt: clock,
    paused: false,
  });
  assignHeldInput(input, {
    horizontal: 1,
    vertical: 0,
    jump: false,
    attack: false,
  });
  prediction.advance(clock, input);
  return { prediction, simulation, clock };
}

test("an optimistic movement skill is predicted immediately and rolled back when refused", () => {
  const simulation = createSimulation(world(), { x: 0, y: -10 });
  const prediction = new OnlinePrediction({});
  prediction.install(simulation, 0);
  const before = captureMotion(simulation);
  const token = prediction.beginOptimistic(
    { kind: "impulse", vx: 400, vy: -250 },
    4111006,
  );
  expect(token).not.toBeNull();
  // The impulse is merged at the key press, not one predicted tick later.
  expect(simulation.vx).toBeGreaterThan(390);
  expect(simulation.vy).toBeLessThan(-150);
  // A rejected cast restores the exact pre-cast checkpoint.
  prediction.rejectOptimistic(token);
  expect(captureMotion(simulation)).toEqual(before);
  expect(prediction.snapshot().pendingImpulses).toBe(0);
});

test("small and moderate corrections ease while a real discontinuity snaps", () => {
  const { prediction, simulation } = presentable();
  const target = { x: 0, y: 0 };
  const now = performance.now();
  simulation.x = 100;
  simulation.previousX = 100;
  prediction.interpolate(now, target);

  // A small disagreement must not repeatedly snap the drawn pose by a few pixels.
  simulation.x = 102;
  simulation.previousX = 102;
  prediction.seedCorrection(100, 0);
  prediction.interpolate(now, target);
  expect(target.x).toBeCloseTo(100, 3);

  // A moderate disagreement eases from the drawn pose onto the authoritative state with
  // zero added velocity at both ends, so it curves instead of nudging.
  const from = target.x;
  simulation.x = 140;
  simulation.previousX = 140;
  prediction.seedCorrection(from, 0);
  prediction.interpolate(now, target);
  expect(target.x).toBeCloseTo(from, 3);
  const quarter = prediction.interpolate(now + 80, target).x;
  const half = prediction.interpolate(now + 160, target).x;
  expect(quarter).toBeGreaterThan(from);
  expect(quarter).toBeLessThan(half);
  expect(half).toBeLessThan(140);
  prediction.interpolate(now + 10000, target);
  expect(target.x).toBeCloseTo(140, 6);

  // A disagreement the kernel cannot explain is a real desync: it is presented outright.
  simulation.x = 900;
  simulation.previousX = 900;
  prediction.seedCorrection(140, 0);
  prediction.interpolate(now + 10000, target);
  expect(target.x).toBeCloseTo(900, 6);
});

test("presented pose stays inside the newest two kernel states", () => {
  const { prediction, simulation, clock } = presentable();
  const target = { x: 0, y: 0 };
  const { previousX, x } = simulation;
  expect(x).toBeGreaterThan(previousX);
  expect(prediction.interpolate(clock, target).x).toBe(previousX);
  const middle = prediction.interpolate(clock + 15, target).x;
  expect(middle).toBeGreaterThan(previousX);
  expect(middle).toBeLessThan(x);
  expect(prediction.interpolate(clock + 30, target).x).toBe(x);
  // Local clock reads outside the step's quantum neither extrapolate nor rewind.
  expect(prediction.interpolate(clock + 60, target).x).toBe(x);
  expect(prediction.interpolate(clock - 10, target).x).toBe(previousX);
});

test("presentation never writes the interpolated pose back into the kernel", () => {
  const { prediction, simulation, clock } = presentable();
  const before = captureMotion(simulation);
  const target = { x: 0, y: 0 };
  for (let step = 0; step <= 30; step += 5) {
    prediction.interpolate(clock + step, target);
    expect(target.x).toBeGreaterThanOrEqual(before.previousX);
    expect(target.x).toBeLessThanOrEqual(before.x);
  }
  expect(captureMotion(simulation)).toEqual(before);
});

test("late scheduler wakes preserve the sub-tick phase of a steady local walk", () => {
  const clock = spyOn(performance, "now").mockReturnValue(6000);
  try {
    const { prediction, simulation } = presentable();
    const held = createHeldInput();
    held.right = true;
    const jitter = [13, 21, 9, 17, 23];
    let previous = null;
    let now = 6000;
    for (let frame = 0; frame < 140; frame++) {
      now += jitter[frame % jitter.length];
      clock.mockReturnValue(now);
      prediction.advance(now, held);
      const x = prediction.interpolate(now, {}).x;
      if (frame > 40) {
        expect(simulation.vx).toBe(125);
        expect(x - previous.x).toBeCloseTo((now - previous.now) * 0.125, 7);
      }
      previous = { x, now };
    }
    expect(prediction.overflows).toBe(0);
    expect(prediction.catchUpDebt).toBe(0);
  } finally {
    clock.mockRestore();
  }
});

test("an ordinary checkpoint leaves the kernel and interpolation phase untouched", () => {
  const clock = spyOn(performance, "now").mockReturnValue(1000);
  try {
    const { prediction, simulation } = presentable();
    prediction.lastStepAt = 985;
    const before = { ...prediction.interpolate(1000, {}) };
    for (const shift of [0.63, 12, 0]) {
      const currentX = simulation.x;
      const motion = captureMotion(simulation);
      motion.x -= shift;
      // A changed previous state also alters the drawn pose when current X agrees.
      motion.previousX -= shift || 9;
      prediction.observe({
        connectionEpoch: "epoch",
        fieldEpoch: "field",
        serverTick: prediction.predictedTick,
        motionEpoch: 1,
        motionConfig: 1,
        motionTick: prediction.predictedTick,
        ackInputSeq: 1,
        paused: false,
        motion,
      });
      const after = prediction.interpolate(1000, {});
      expect(after.x).toBeCloseTo(before.x, 6);
      expect(after.y).toBeCloseTo(before.y, 6);
      expect(simulation.x).toBe(currentX);
    }
  } finally {
    clock.mockRestore();
  }
});

test("ordinary correction cannot reverse a steady walk while recovering a gap", () => {
  let now = 1000;
  const clock = spyOn(performance, "now").mockImplementation(() => now);
  try {
    const { prediction, simulation } = presentable();
    simulation.x = simulation.previousX = 100;
    prediction.drawnX = 200;
    prediction.drawnY = simulation.y;
    prediction.seedCorrection(200, simulation.y);
    let previous = prediction.interpolate(now, {}).x;
    for (let elapsed = 10; elapsed <= 1600; elapsed += 10) {
      now = 1000 + elapsed;
      simulation.x = simulation.previousX = 100 + 0.125 * elapsed;
      const current = prediction.interpolate(now, {}).x;
      expect(current).toBeGreaterThanOrEqual(previous - 0.001);
      previous = current;
    }
    expect(previous).toBeCloseTo(simulation.x, 6);
  } finally {
    clock.mockRestore();
  }
});

test("a dropped frame cannot teleport an animation clock", () => {
  const advanced = [];
  const owner = { selfId: "other", localCombat: null };
  const view = {
    entity: { id: "other", combatState: null },
    observedAge: 0,
    motion: {},
    actionClock: {
      phase: 0,
      advance(ms) {
        this.phase += ms;
      },
    },
    animation: {
      current: { duration: 1000 },
      advance: (ms) => advanced.push(ms),
      seek: () => {},
    },
  };
  OnlineScene.prototype.advanceView.call(owner, view, 500);
  // At most two 30 ms quanta are presented; the rest of the hitch is discarded rather
  // than jumping the animation through half a second of frames.
  expect(advanced).toEqual([60]);
  expect(view.actionClock.phase).toBe(60);
});

test("midair attack locks retain the local interpolation clock instead of chasing old entity poses", () => {
  const { prediction, simulation, clock } = presentable();
  const input = createHeldInput();
  assignHeldInput(input, {
    horizontal: 1,
    vertical: 0,
    jump: true,
    attack: false,
  });
  stepMotion(simulation, input);
  simulation.movementLocked = true;
  stepMotion(simulation, input);
  expect(simulation.y).toBeLessThan(simulation.previousY);
  const owner = { selfId: "self", drawPrediction: prediction, selfPose: {} };
  const view = {
    entity: {
      id: "self",
      position: { x: -100, y: 0 },
      combatState: { movementLocked: true },
    },
    fromX: -100,
    fromY: 0,
    received: clock,
  };
  const before = captureMotion(simulation);
  const result = OnlineScene.prototype.interpolateView.call(
    owner,
    view,
    clock + 15,
  );
  expect(result).toBe(simulation);
  expect(view.drawY).toBe((simulation.previousY + simulation.y) / 2);
  expect(view.drawX).toBe((simulation.previousX + simulation.x) / 2);
  view.entity.combatState.movementLocked = false;
  OnlineScene.prototype.interpolateView.call(owner, view, clock + 15);
  expect(view.drawY).toBe((simulation.previousY + simulation.y) / 2);
  expect(captureMotion(simulation)).toEqual(before);
});

test("a server-owned relocation reaches the local prediction, not only the drawn pose", () => {
  const { prediction, simulation } = presentable();
  const before = captureMotion(simulation);
  expect(before.x).not.toBe(10);
  prediction.relocate(10, -20);
  expect(simulation.x).toBe(10);
  expect(simulation.y).toBe(-20);
  expect(simulation.previousX).toBe(10);
  expect(simulation.previousY).toBe(-20);
  expect(simulation.vx).toBe(0);
  expect(simulation.vy).toBe(0);
  // History is retired so the next report extends the relocated state, not the old one.
  expect(prediction.snapshot().history).toBe(0);
});

test("a committed transition holds the local pose instead of using remote interpolation", () => {
  // Between the commit message and the destination install the predictor is briefly not
  // ready. The self must hold its last predicted pose, never the delayed remote sample.
  const view = {
    entity: { id: "self" },
    motion: { x: 0, y: 0, sample: () => ({ x: 0, y: 0 }) },
    drawX: 0,
    drawY: 0,
  };
  const owner = {
    selfId: "self",
    drawPrediction: null,
    simulationSource: { x: 340, y: -12 },
    remoteActive: true,
    motionNow: 500,
    pose() {},
  };
  const result = OnlineScene.prototype.interpolateView.call(owner, view, 500);
  expect(result).toBeNull();
  expect(view.drawX).toBe(340);
  expect(view.drawY).toBe(-12);
});

test("a paused portal transition keeps drawing the local player from its own prediction", () => {
  // While the transport is transitioning `active` is false. The self must still present its
  // own prediction: falling back to the remote interpolator would draw the player from a
  // delayed server snapshot and throw its coordinates before the map changes.
  const simulation = { x: 120, y: 30 };
  const prediction = {
    ready: true,
    paused: false,
    simulation,
    interpolate(now, target) {
      target.x = simulation.x;
      target.y = simulation.y;
      return target;
    },
  };
  const view = {
    entity: {
      id: "self",
      position: { x: 0, y: 0 },
      action: 1,
      combatState: null,
    },
    motion: { sample: () => ({ x: 0, y: 0 }) },
    fromX: 0,
    fromY: 0,
    drawX: 0,
    drawY: 0,
  };
  const owner = {
    selfId: "self",
    paused: false,
    remoteActive: false,
    motionNow: 0,
    selfPose: {},
    presentation: { x: 0, y: 0, facing: 0, action: "stand1" },
    localCombat: null,
    drawPrediction: null,
    observedSimulation: Object.create(null),
    simulationSource: null,
    views: new Map([["self", view]]),
    geometry: { visible: false },
    scene: { updateActor() {} },
    events: { draw() {} },
    drops: { draw() {} },
    chairs: { draw() {}, observe() {} },
    native: null,
    syncPrediction: OnlineScene.prototype.syncPrediction,
    drawView: OnlineScene.prototype.drawView,
    drawActors: OnlineScene.prototype.drawActors,
    interpolateView: OnlineScene.prototype.interpolateView,
    drawSelfPose: OnlineScene.prototype.drawSelfPose,
    drawNpcs() {},
    updateCamera() {},
    drawScenery() {},
  };
  OnlineScene.prototype.draw.call(owner, 1000, 16, prediction, false);
  expect(owner.drawPrediction).toBe(prediction);
  expect(owner.simulationSource).toBe(simulation);
  expect(view.drawX).toBe(120);
  expect(view.drawY).toBe(30);
});

test("a jump released between scheduler steps still reaches local and server input", () => {
  const { prediction, simulation, clock } = presentable();
  let transmitted = null;
  prediction.onInput = (sample) => {
    transmitted = structuredClone(sample);
    return 2;
  };
  const held = createHeldInput();
  held.jumpPressed = true;
  prediction.advance(clock + 30, held);
  expect(transmitted.jump).toBe(true);
  expect(simulation.groundJumpSequence).toBe(1);
  expect(simulation.vy).toBeLessThan(0);
  held.jumpPressed = false;
  prediction.advance(clock + 60, held);
  expect(transmitted.jump).toBe(false);
});

test("a local ground jump cues sound before any checkpoint, with silent replay and echo", () => {
  let sounds = 0;
  const { prediction, simulation, clock } = presentable(() => sounds++);
  const beforeJump = captureMotion(simulation);
  const previousTick = prediction.predictedTick;
  const held = createHeldInput();
  held.jump = true;
  prediction.advance(clock + 30, held);
  expect(simulation.groundJumpSequence).toBe(1);
  expect(sounds).toBe(1);
  const afterJump = captureMotion(simulation);
  function checkpoint(tick, motion) {
    prediction.observe({
      connectionEpoch: "epoch",
      fieldEpoch: "field",
      serverTick: tick,
      motionEpoch: 1,
      motionConfig: 1,
      motionTick: prediction.predictedTick,
      ackInputSeq: 1,
      paused: false,
      motion,
    });
  }
  checkpoint(previousTick, beforeJump);
  checkpoint(previousTick, beforeJump);
  expect(sounds).toBe(1);
  checkpoint(previousTick + 1, afterJump);
  checkpoint(previousTick + 1, afterJump);
  expect(sounds).toBe(1);
});

test("only locally accepted jumps cue sound, including sequence wrap", () => {
  let sounds = 0;
  const { prediction, simulation, clock } = presentable(() => sounds++);
  const held = createHeldInput();
  held.jump = true;
  simulation.fieldLimit = 1;
  prediction.advance(clock + 30, held);
  expect(simulation.state).toBe("ground");
  expect(sounds).toBe(0);
  simulation.fieldLimit = 0;
  simulation.groundJumpSequence = 0xffffffff;
  prediction.advance(clock + 60, held);
  expect(simulation.groundJumpSequence).toBe(0);
  expect(sounds).toBe(1);
  held.jump = false;
  prediction.advance(clock + 90, held);
  held.jump = true;
  prediction.advance(clock + 120, held);
  expect(simulation.state).toBe("air");
  expect(sounds).toBe(1);
});

test("checkpoint jumps, sequence wrap and rejoin never emit delayed jump audio", () => {
  let sounds = 0;
  const { prediction, simulation } = presentable(() => sounds++);
  const source = createSimulation(world(), { x: 0, y: 0 });
  restoreMotion(source, captureMotion(simulation));
  const input = createHeldInput();
  let tick = prediction.predictedTick;
  function observe() {
    prediction.observe({
      connectionEpoch: "epoch",
      fieldEpoch: "field",
      serverTick: ++tick,
      motionEpoch: 1,
      motionConfig: 1,
      motionTick: prediction.predictedTick,
      ackInputSeq: 1,
      paused: false,
      motion: captureMotion(source),
    });
  }
  assignHeldInput(input, {
    horizontal: 1,
    vertical: 0,
    jump: true,
    attack: false,
  });
  stepMotion(source, input);
  expect(source.groundJumpSequence).toBe(1);
  observe();
  observe();
  expect(sounds).toBe(0);
  assignHeldInput(input, {
    horizontal: 1,
    vertical: 0,
    jump: false,
    attack: false,
  });
  stepMotion(source, input);
  assignHeldInput(input, {
    horizontal: 1,
    vertical: 0,
    jump: true,
    attack: false,
  });
  stepMotion(source, input);
  observe();
  expect(sounds).toBe(0);
  prediction.install(simulation, tick);
  observe();
  expect(sounds).toBe(0);
  source.groundJumpSequence = 0xffffffff;
  prediction.install(simulation, tick);
  observe();
  source.groundJumpSequence = 0;
  observe();
  expect(sounds).toBe(0);
});

test("prediction covers network delay within a bounded history horizon", () => {
  const sent = [];
  const simulation = createSimulation(world(), { x: 0, y: -10 });
  const prediction = new OnlinePrediction({
    onInput(sample) {
      sent.push({ ...sample, motion: { ...sample.motion } });
      return sent.length;
    },
  });
  const observation = {
    connectionEpoch: "epoch",
    fieldEpoch: "destination",
    serverTick: 13,
    motionEpoch: 1,
    motionConfig: 1,
    motionTick: 13,
    ackInputSeq: null,
    paused: false,
    motion: captureMotion(simulation),
  };
  prediction.install(simulation, observation.serverTick);
  prediction.observe(observation);
  const now = performance.now();
  const clock = new ServerClock();
  prediction.timing(
    clock.observe({ ...observation, receivedAt: now, roundTripMs: 300 }),
  );
  const held = createHeldInput();
  held.right = true;
  // Explicit scheduler times, independent of test-runner stalls and RAF cadence.
  for (let step = 0; step < 10; step++) {
    prediction.advance(now + step * PROTOCOL.TICK_MS, held);
  }
  expect(sent.length).toBeGreaterThan(1);
  expect(sent[0]).toMatchObject({
    horizontal: 1,
    vertical: 0,
    jump: false,
    attack: false,
  });
  expect(sent[0].targetTick).toBe(observation.motionTick + 1);
  expect(sent.at(-1).targetTick).toBe(observation.motionTick + 9);
  expect(prediction.count).toBeLessThan(PROTOCOL.INPUT_HISTORY);
  // The same sample reports the bounded motion state it extends, for the server's
  // adoption check; the values are asserted by the divert-alignment suite.
  expect(Object.keys(sent[0].motion).sort()).toEqual(["vx", "vy", "x", "y"]);
  for (const value of Object.values(sent[0].motion)) {
    expect(Number.isFinite(value)).toBe(true);
  }
  expect(simulation.x).toBeGreaterThan(observation.motion.x);
});

test("a freshly installed predictor waits for matching field timing", () => {
  const sent = [];
  const simulation = createSimulation(world(), { x: 0, y: -10 });
  const prediction = new OnlinePrediction({
    onInput(sample) {
      sent.push({ ...sample, motion: { ...sample.motion } });
      return sent.length;
    },
  });
  const clock = new ServerClock();
  prediction.timing(
    clock.observe({
      connectionEpoch: "epoch",
      fieldEpoch: "source",
      serverTick: 100000,
      paused: false,
      receivedAt: performance.now(),
      roundTripMs: 30,
    }),
  );
  prediction.install(simulation, 13);
  const before = captureMotion(simulation);
  prediction.observe({
    connectionEpoch: "epoch",
    fieldEpoch: "destination",
    serverTick: 13,
    motionEpoch: 1,
    motionConfig: 1,
    motionTick: 13,
    ackInputSeq: null,
    paused: false,
    motion: before,
  });
  const now = performance.now();
  const held = createHeldInput();
  held.right = true;
  for (let step = 0; step < PROTOCOL.INPUT_HISTORY; step++) {
    prediction.advance(now + step, held);
  }
  expect(sent).toEqual([]);
  expect(captureMotion(simulation)).toEqual(before);
});
