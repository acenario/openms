import { expect, test } from "bun:test";
import original from "../../docs/ghidra-physics-motion/wz-globals.json";
import { createSimulation } from "../src/physics/simulation.js";
import { captureMotion, createHeldInput } from "../../shared/motion.js";
import { OnlinePrediction } from "../src/online/prediction.js";
import { LocalHitMotion } from "../src/online/local-hit-motion.js";

function fixture() {
  const physics = {
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
    ],
  };
  let seq = 0;
  const prediction = new OnlinePrediction({ onInput: () => ++seq });
  const simulation = createSimulation(physics, { x: 0, y: 0 });
  prediction.install(simulation, 0);
  prediction.observe({
    connectionEpoch: "connection",
    fieldEpoch: "field",
    serverTick: 0,
    motionEpoch: 1,
    motionConfig: 1,
    motionTick: 0,
    ackInputSeq: null,
    paused: false,
    authoritative: true,
    motion: captureMotion(simulation),
    diverts: [],
  });
  const held = createHeldInput();
  prediction.predict(held, true);
  const preview = new LocalHitMotion(prediction, physics);
  return { prediction, simulation, preview, held };
}

test("contact recoil draws before confirmation while reported movement remains untouched", () => {
  const f = fixture();
  const before = captureMotion(f.simulation);
  expect(f.preview.begin("mob", 1)).toBe(true);
  expect(captureMotion(f.simulation)).toEqual(before);
  for (let i = 0; i < 5; i++) f.prediction.predict(f.held, true);
  const pose = f.prediction.interpolate(1000, {});
  expect(pose.x).toBeGreaterThan(f.simulation.x + 10);
  expect(pose.y).toBeLessThan(f.simulation.y);
  expect(f.prediction.resumeMotion().x).toBe(f.simulation.x);
  const accepted = { x: f.simulation.x, y: f.simulation.y };
  expect(f.preview.confirm({ sourceId: "another-mob" })).toBe(false);
  expect(
    f.prediction.applyDiverts([
      { id: 1, skillId: 0, source: "hit", sourceId: "mob", vx: 270, vy: -270 },
    ]),
  ).toBe(1);
  expect(f.simulation.x).toBe(accepted.x);
  expect(f.simulation.y).toBe(accepted.y);
  expect(f.simulation.vx).toBe(270);
  expect(f.simulation.vy).toBe(-270);
  expect(f.preview.sourceId).toBeNull();
});

test("a refused or resisted recoil eases back without moving the unconfirmed gameplay path", () => {
  const f = fixture();
  f.preview.begin("mob", -1);
  for (let i = 0; i < 5; i++) f.prediction.predict(f.held, true);
  const pose = f.prediction.interpolate(performance.now(), {});
  f.preview.reject("mob");
  expect(f.simulation.x).toBe(0);
  const corrected = f.prediction.interpolate(performance.now(), {});
  expect(corrected.x).toBeCloseTo(pose.x, 0);
  expect(f.prediction.interpolate(performance.now() + 1000, {}).x).toBe(0);
});

test("a lost confirmation expires bounded recoil and relocation discards an old preview", () => {
  const f = fixture();
  f.preview.begin("mob", 1);
  for (let i = 0; i < 134; i++) f.preview.step(f.held);
  expect(f.preview.sourceId).toBeNull();
  expect(f.simulation.x).toBe(0);
  f.preview.begin("mob", 1);
  f.prediction.relocate(200, 0);
  expect(f.preview.sourceId).toBeNull();
  expect(f.prediction.interpolate(1000, {}).x).toBe(200);
  f.preview.destroy();
  expect(f.prediction.hitPreview).toBeNull();
});

test("a different admitted hit vector replaces the preview instead of keeping a wrong recoil", () => {
  const f = fixture();
  f.preview.begin("mob", 1);
  f.prediction.predict(f.held, true);
  expect(
    f.prediction.applyDiverts([
      { id: 1, skillId: 0, source: "hit", sourceId: "mob", vx: -270, vy: -270 },
    ]),
  ).toBe(1);
  expect(f.preview.sourceId).toBeNull();
  expect(f.simulation.vx).toBe(-270);
  expect(f.simulation.vy).toBe(-270);
});
