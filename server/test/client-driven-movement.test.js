import { test, expect, spyOn } from "bun:test";
import { loadContent } from "../src/content.js";
import {
  createSimulation,
  applyExternalImpulse,
  relocateSimulation,
} from "../../client/src/physics/simulation.js";
import {
  createHeldInput,
  assignHeldInput,
  captureMotion,
  restoreMotion,
  stepMotion,
} from "../../shared/motion.js";
import { OnlinePrediction } from "../../client/src/online/prediction.js";
import {
  advanceMovementStream,
  enqueueMovement,
  movementStreamView,
} from "../src/movement-stream.js";
import {
  prepareMotionDiverts,
  recordMotionDivert,
  takeMotionDiverts,
} from "../src/field-diverts.js";
import { PROTOCOL } from "../../shared/protocol.js";

const content = await loadContent();
const physics = (await content.map("100000000")).physics;

function fixture() {
  const simulation = createSimulation(physics, { x: 80, y: 274 });
  const actor = {
    id: "walker",
    state: "active",
    profile: { hp: 100 },
    simulation,
    field: { epoch: "field", tick: 100 },
    input: createHeldInput(),
    inputQueue: new Map(),
    attackEdges: [],
    receivedAttack: false,
    ackInputSeq: 0,
    actionStartTick: 0,
  };
  const faults = [];
  const world = {
    faultMotion(_actor, detail) {
      faults.push(detail);
    },
  };
  const client = createSimulation(physics, { x: 80, y: 274 });
  restoreMotion(client, captureMotion(simulation));
  prepareMotionDiverts(actor, actor.field);
  movementStreamView(actor);
  return {
    actor,
    client,
    world,
    faults,
    held: createHeldInput(),
    tick: 100,
    seq: 0,
  };
}

function report(probe, controls = {}) {
  const sample = {
    fieldEpoch: "field",
    inputSeq: ++probe.seq,
    targetTick: ++probe.tick,
    motionEpoch: probe.actor.movementStream.epoch,
    motionConfig: probe.actor.movementStream.configurations.at(-1).version,
    movementLocked: false,
    horizontal: 1,
    vertical: 0,
    jump: false,
    attack: false,
    impulses: [],
    ...controls,
  };
  assignHeldInput(probe.held, sample);
  for (const impulse of sample.impulses) {
    const grant = probe.actor.movementStream.grants.find(
      (entry) => entry.id === impulse.id || entry.skillId === impulse.skillId,
    );
    applyExternalImpulse(probe.client, grant.vx, grant.vy);
  }
  stepMotion(probe.client, probe.held);
  const { x, y, vx, vy } = probe.client;
  sample.motion = { x, y, vx, vy };
  return sample;
}
function advance(probe, count = 1) {
  for (let i = 0; i < count; i++) {
    probe.actor.field.tick++;
    advanceMovementStream(probe.world, probe.actor);
  }
}

test("delayed walking and jumps retain every terrain-validated step without a clock deadline", () => {
  const probe = fixture();
  const packets = [];
  for (let tick = 0; tick < 100; tick++) {
    packets.push(
      report(probe, { jump: tick === 14, horizontal: tick < 50 ? 1 : -1 }),
    );
    advance(probe);
  }
  const heldX = probe.actor.simulation.x;
  expect(heldX).toBe(80);
  for (const packet of packets) enqueueMovement(probe.actor, packet);
  advance(probe, 25);
  expect(probe.faults).toEqual([]);
  expect(probe.actor.ackInputSeq).toBe(100);
  expect(probe.actor.simulation.x).toBe(probe.client.x);
  expect(probe.actor.simulation.y).toBe(probe.client.y);
  expect(probe.actor.simulation.groundJumpSequence).toBe(1);
  expect(probe.actor.peerMoveQueue.count).toBeGreaterThan(50);
});

test.each(["x", "y", "vx", "vy"])(
  "forged %s never reaches shared-world state even with abuse watchdog disabled",
  (key) => {
    const probe = fixture();
    const before = captureMotion(probe.actor.simulation);
    const packet = report(probe);
    packet.motion[key] += 50;
    enqueueMovement(probe.actor, packet);
    advance(probe);
    expect(probe.faults).toHaveLength(1);
    expect(captureMotion(probe.actor.simulation)).toEqual(before);
    expect(probe.actor.ackInputSeq).toBe(0);
  },
);

test("a faster client clock cannot buy physics time, and the input backlog is bounded", () => {
  const probe = fixture();
  for (let tick = 0; tick < PROTOCOL.INPUT_HISTORY; tick++) {
    enqueueMovement(probe.actor, report(probe));
  }
  advance(probe, 10);
  expect(probe.actor.movementStream.steps).toBe(10);
  expect(probe.actor.inputQueue.size).toBe(PROTOCOL.INPUT_HISTORY - 10);
  for (let tick = 0; tick < 10; tick++) {
    enqueueMovement(probe.actor, report(probe));
  }
  expect(() => enqueueMovement(probe.actor, report(probe))).toThrow(
    "RATE_LIMITED",
  );
  expect(probe.faults).toEqual([]);
});

test("a forced relocation retires old reports and a forged path gap is rejected", () => {
  const probe = fixture();
  const old = report(probe);
  relocateSimulation(probe.actor.simulation, { x: 100, y: 274 });
  enqueueMovement(probe.actor, old);
  expect(probe.actor.inputQueue.size).toBe(0);
  expect(probe.actor.simulation.x).toBe(100);
  expect(() =>
    enqueueMovement(probe.actor, {
      ...old,
      motionEpoch: probe.actor.movementStream.epoch,
      motionConfig: probe.actor.movementStream.configurations.at(-1).version,
      targetTick: 10000,
    }),
  ).toThrow("INVALID_MESSAGE");
});

test("an admitted impulse is applied at the client's reported step, never twice on reply", () => {
  const probe = fixture();
  const sim = probe.actor.simulation;
  applyExternalImpulse(sim, 450, -300, () =>
    recordMotionDivert(probe.actor, sim, {
      source: "skill",
      skillId: 4111006,
      vx: 450,
      vy: -300,
    }),
  );
  // Older ordinary input arrived before the skill reply; it remains admissible.
  enqueueMovement(probe.actor, report(probe));
  advance(probe);
  const diverts = takeMotionDiverts(probe.actor, probe.actor.field);
  expect(diverts).toHaveLength(1);
  const epoch = probe.actor.movementStream.epoch;
  enqueueMovement(
    probe.actor,
    report(probe, {
      impulses: [{ id: null, source: "skill", skillId: 4111006 }],
    }),
  );
  advance(probe);
  expect(probe.faults).toEqual([]);
  expect(probe.actor.movementStream.epoch).toBe(epoch);
  expect(probe.actor.movementStream.grants).toHaveLength(0);
  expect(probe.actor.simulation.x).toBe(probe.client.x);
  expect(probe.actor.simulation.vy).toBe(probe.client.vy);
});

function predictor(probe, now) {
  const prediction = new OnlinePrediction({
    onInput: (sample) => {
      enqueueMovement(
        probe.actor,
        structuredClone({ ...sample, inputSeq: ++probe.seq }),
      );
      return probe.seq;
    },
  });
  prediction.install(probe.client, probe.actor.field.tick);
  const frame = {
    connectionEpoch: "connection",
    fieldEpoch: "field",
    serverTick: probe.actor.field.tick,
    ...movementStreamView(probe.actor),
    motion: captureMotion(probe.actor.simulation),
    ackInputSeq: 0,
    paused: false,
    authoritative: false,
    diverts: [],
  };
  prediction.observe(frame);
  prediction.timing({
    ...frame,
    ready: true,
    receivedAt: now,
    oneWayMs: 1000,
    tickOffsetMs: -10000,
  });
  return { prediction, frame };
}

test("local movement is independent of RTT, jitter and stale ordinary positions", () => {
  const clock = spyOn(performance, "now").mockReturnValue(1000);
  try {
    const probe = fixture();
    const { prediction, frame } = predictor(probe, 1000);
    const held = createHeldInput();
    held.right = true;
    for (let tick = 1; tick <= 50; tick++) {
      clock.mockReturnValue(1000 + tick * 30);
      prediction.advance(performance.now(), held);
      advance(probe);
      const before = captureMotion(probe.client);
      prediction.observe({
        ...frame,
        serverTick: 100 + tick,
        ackInputSeq: probe.actor.ackInputSeq,
      });
      expect(captureMotion(probe.client)).toEqual(before);
    }
    expect(probe.faults).toEqual([]);
    expect(probe.client.x).toBe(probe.actor.simulation.x);
    expect(prediction.predictedTick).toBe(150);
    expect(prediction.corrections).toBe(0);
    expect(prediction.replayedTicks).toBe(0);
    expect(prediction.count).toBe(0);
  } finally {
    clock.mockRestore();
  }
});

test("an ability change accepts in-flight old coefficients without replacing local position", () => {
  const probe = fixture();
  const packet = report(probe);
  const epoch = probe.actor.movementStream.epoch;
  probe.actor.simulation.effectiveSettings.walkSpeed = 175;
  const update = movementStreamView(probe.actor);
  expect(update.motionEpoch).toBe(epoch);
  expect(update.motionConfig).toBe(2);
  enqueueMovement(probe.actor, packet);
  advance(probe);
  expect(probe.faults).toEqual([]);
  expect(probe.actor.simulation.x).toBe(probe.client.x);
  expect(probe.actor.simulation.effectiveSettings.walkSpeed).toBe(175);
  probe.client.effectiveSettings.walkSpeed = 175;
  enqueueMovement(probe.actor, report(probe));
  advance(probe);
  expect(probe.faults).toEqual([]);
  expect(probe.actor.simulation.x).toBe(probe.client.x);
  expect(movementStreamView(probe.actor).motionConfig).toBe(2);
});

test.each(["coefficient", "force"])(
  "an unissued %s cannot change accepted position",
  (kind) => {
    const probe = fixture();
    const before = captureMotion(probe.actor.simulation);
    const packet = report(probe);
    if (kind === "coefficient") packet.motionConfig = 99;
    else packet.impulses.push({ id: 99, source: "hit", skillId: 0 });
    enqueueMovement(probe.actor, packet);
    advance(probe);
    expect(probe.faults).toHaveLength(1);
    expect(captureMotion(probe.actor.simulation)).toEqual(before);
    expect(probe.actor.ackInputSeq).toBe(0);
  },
);

test("unapproved optimistic movement waits a bounded time and cannot affect the world", () => {
  const probe = fixture();
  const packet = report(probe);
  packet.impulses.push({ id: null, source: "skill", skillId: 4111006 });
  enqueueMovement(probe.actor, packet);
  advance(probe, PROTOCOL.INPUT_HISTORY - 1);
  expect(probe.actor.simulation.x).toBe(80);
  expect(probe.actor.ackInputSeq).toBe(0);
  expect(probe.faults).toEqual([]);
  advance(probe);
  expect(probe.faults).toHaveLength(1);
  expect(probe.actor.simulation.x).toBe(80);
});

test("a consumed hit approval cannot be replayed for another impulse", () => {
  const probe = fixture();
  const sim = probe.actor.simulation;
  applyExternalImpulse(sim, 270, -270, () =>
    recordMotionDivert(probe.actor, sim, {
      source: "hit",
      skillId: 0,
      vx: 270,
      vy: -270,
    }),
  );
  const reference = { id: 1, source: "hit", skillId: 0 };
  enqueueMovement(probe.actor, report(probe, { impulses: [reference] }));
  advance(probe);
  expect(probe.faults).toEqual([]);
  const before = captureMotion(sim);
  const packet = report(probe);
  packet.impulses.push(reference);
  enqueueMovement(probe.actor, packet);
  advance(probe);
  expect(probe.faults).toHaveLength(1);
  expect(captureMotion(sim)).toEqual(before);
});

test("withholding movement cannot suspend gravity indefinitely or erase time on reconnect", () => {
  const probe = fixture();
  probe.actor.simulation.y = -200;
  probe.actor.simulation.previousY = -200;
  probe.actor.connection = {};
  movementStreamView(probe.actor);
  let recoveries = 0;
  probe.world.expireMovement = () => recoveries++;
  advance(probe, PROTOCOL.INPUT_HISTORY + 1);
  expect(recoveries).toBe(1);
  expect(probe.faults).toEqual([]);
  probe.actor.connection = null;
  advance(probe);
  expect(probe.actor.simulation.y).toBeGreaterThan(-200);
  const y = probe.actor.simulation.y;
  probe.actor.connection = {};
  movementStreamView(probe.actor);
  expect(probe.actor.simulation.y).toBe(y);
});
