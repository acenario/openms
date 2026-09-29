import { expect, test } from "bun:test";
import { loadContent } from "../src/content.js";
import { movementStreamView } from "../src/movement-stream.js";
import { OnlineWorld } from "../src/world.js";
import { prepareActorCombat } from "../src/field-combat.js";
import { prepareActorSkills, disposeActorSkills } from "../src/field-skills.js";
import { MotionWatchdog, WATCHDOG_POLICY } from "../src/watchdog.js";
import { createProfile } from "../../client/src/profile/profile-validation.js";
import { createSimulation } from "../../client/src/physics/simulation.js";
import {
  stepMotion,
  captureMotion,
  restoreMotion,
  createHeldInput,
} from "../../shared/motion.js";
import {
  MOTION_PLAUSIBILITY,
  PROTOCOL,
  decodeServer,
  plausiblePositionPx,
} from "../../shared/protocol.js";
import { recordMotionDivert, takeMotionDiverts } from "../src/field-diverts.js";
import { serverOwnsPosition } from "../src/motion-authority.js";
import { adoptMotion } from "../src/motion-adoption.js";
import { attachGround } from "../../client/src/physics/geometry.js";
import { serverConfig } from "../src/config.js";

const content = await loadContent();

/** Real field, real kernel and the real moveActor admission path; only persistence and
 *  mob population are isolated, so nothing about the wire contract is stubbed. */
async function fixture(mapId = 100000000, watchdogEnabled = true) {
  const publications = [];
  const events = [];
  const world = new OnlineWorld({
    content,
    database: {},
    watchdogEnabled,
    publish(actor, message) {
      publications.push({ actor: actor.id, message });
    },
    log(event, detail) {
      events.push({ event, detail });
    },
  });
  const field = await world.fieldFor(mapId);
  field.mobs = [];
  const saved = { mapId: field.manifest.id, x: 0, y: 0, facing: 1 };
  const profile = createProfile(saved);
  profile.hp = 100;
  profile.maxHP = 100;
  profile.mp = 10;
  profile.maxMP = 10;
  recalculateVitals(profile, content.items);
  profile.onlineState = { effects: [], cooldowns: {} };
  const actor = {
    id: "watched",
    profile,
    revision: 0,
    session: { expiresAt: Date.now() + 60000 },
  };
  world.prepareEntry(actor, field);
  prepareActorCombat(world, actor);
  await prepareActorSkills(world, actor);
  actor.state = "active";
  field.characters.set(actor.id, actor);
  world.actors.set(actor.id, actor);
  return { world, field, actor, publications, events };
}

function recalculateVitals(profile, items) {
  profile.maxHP = 100;
  profile.maxMP = 10;
  profile.hp = Math.min(profile.hp, profile.maxHP);
  profile.mp = Math.min(profile.mp, profile.maxMP);
  void items;
}

/** Place the server's simulation at a known base so an adoption delta is exact. */
function place(actor, x, y) {
  const sim = actor.simulation;
  sim.x = x;
  sim.y = y;
  sim.previousX = x;
  sim.previousY = y;
  sim.vx = 0;
  sim.vy = 0;
  actor.lastAdoptedTick = actor.field.tick;
}

function faults(probe) {
  return probe.events.filter(
    (entry) =>
      entry.event === "watchdog.fault" || entry.event === "motion.fault",
  );
}

function dispose(probe) {
  for (const actor of probe.world.actors.values()) {
    disposeActorSkills(actor, true);
  }
}

let sequence = 0;
function input(actor, motion) {
  sequence++;
  return {
    fieldEpoch: actor.field.epoch,
    inputSeq: sequence,
    ...movementStreamView(actor),
    targetTick: actor.movementStream.tick + actor.inputQueue.size + 1,
    movementLocked: false,
    impulses: [],
    horizontal: 0,
    vertical: 0,
    jump: false,
    attack: false,
    ...(motion ? { motion } : {}),
  };
}

function advance(probe, ticks) {
  for (let count = 0; count < ticks; count++) {
    probe.field.tick++;
    probe.world.moveActor(probe.actor);
  }
}

test("delayed movement follows the complete client path through the real world admission", async () => {
  const probe = await fixture(10000);
  try {
    const { actor, world, field } = probe;
    world.moveActor(actor);
    const client = createSimulation(field.manifest.physics, { x: 0, y: 0 });
    restoreMotion(client, captureMotion(actor.simulation));
    const held = createHeldInput();
    const pending = [];
    let targetTick = actor.movementStream.tick;
    for (let tick = 0; tick < 240; tick++) {
      held.right = tick < 130;
      stepMotion(client, held);
      const sample = input(actor, {
        x: client.x,
        y: client.y,
        vx: client.vx,
        vy: client.vy,
      });
      sample.targetTick = ++targetTick;
      sample.horizontal = held.right ? 1 : 0;
      pending.push(sample);
      if (tick < 80 || tick >= 130) {
        for (const packet of pending) world.input(actor, packet);
        pending.length = 0;
      }
      advance(probe, 1);
      expect(actor.retiring).not.toBe(true);
    }
    expect(faults(probe)).toEqual([]);
    expect(actor.simulation.x).toBe(client.x);
    expect(actor.simulation.y).toBe(client.y);
  } finally {
    dispose(probe);
  }
});

test("admitted jumps and departures release stale ground and ladder contacts without snapping", async () => {
  const probe = await fixture(10000);
  try {
    const sim = probe.actor.simulation;
    place(probe.actor, 130, 305);
    attachGround(sim, sim.geometry.byId.get(51));
    adoptMotion(sim, { x: 130, y: 295, vx: 0, vy: -50 });
    expect(sim.foothold).toBeNull();
    expect(sim.y).toBe(295);
    stepMotion(sim, createHeldInput());
    expect(sim.y).toBeLessThan(295);
    sim.ladder = sim.ladders[0];
    sim.ladderId = sim.ladder.id;
    sim.state = "ladder";
    adoptMotion(sim, { x: 975, y: 200, vx: 0, vy: 0 });
    expect(sim.ladder).not.toBeNull();
    adoptMotion(sim, { x: 1025, y: 200, vx: 50, vy: 0 });
    expect(sim.ladder).toBeNull();
    expect(sim.ladderId).toBe(0);
    expect(sim.x).toBe(1025);
    expect(sim.foothold).toBeNull();
  } finally {
    dispose(probe);
  }
});

test("even a small client-reported displacement cannot replace the server kernel", async () => {
  const probe = await fixture();
  try {
    const { world, field, actor } = probe;
    actor.simulation.x = 0;
    actor.simulation.y = 0;
    actor.simulation.vx = 0;
    actor.simulation.vy = 0;
    world.moveActor(actor);
    const expected = captureMotion(actor.simulation);
    const report = { x: 3, y: -1, vx: 120, vy: 0 };
    world.input(actor, input(actor, report));
    advance(probe, 1);
    expect(captureMotion(actor.simulation)).toEqual(expected);
    expect(actor.retiring).toBe(true);
    expect(field.tick).toBe(1);
  } finally {
    dispose(probe);
  }
});

test("a report without motion leaves the authoritative simulation untouched", async () => {
  const probe = await fixture();
  try {
    const { world, actor } = probe;
    actor.simulation.x = 12;
    actor.simulation.y = 0;
    expect(() => world.input(actor, input(actor, null))).toThrow(
      "INVALID_MESSAGE",
    );
    advance(probe, 1);
    expect(actor.simulation.x).not.toBe(12 + 40);
    expect(actor.lastAdoptedTick).toBe(0);
  } finally {
    dispose(probe);
  }
});

test("one impossible report faults immediately and is not adopted", async () => {
  const probe = await fixture();
  try {
    const { world, actor } = probe;
    place(actor, 0, 0);
    world.moveActor(actor);
    const teleport = plausiblePositionPx(PROTOCOL.TICK_MS) * 10;
    world.input(actor, input(actor, { x: teleport, y: 0, vx: 0, vy: 0 }));
    advance(probe, 1);
    expect(actor.simulation.previousX).not.toBe(teleport);
    expect(actor.retiring).toBe(true);
    expect(probe.events.some((entry) => entry.event === "motion.fault")).toBe(
      true,
    );
  } finally {
    dispose(probe);
  }
});

test("a plausible reconnect report cannot replace trusted position", async () => {
  const probe = await fixture();
  try {
    const { world, field, actor } = probe;
    // Three seconds of walking: 100 ticks at the kernel quantum.
    const gapTicks = 100;
    actor.lastAdoptedTick = 0;
    field.tick = gapTicks;
    const walked = { x: 600, y: 0, vx: 45, vy: 0 };
    expect(plausiblePositionPx(gapTicks * PROTOCOL.TICK_MS)).toBeGreaterThan(
      600,
    );
    const before = captureMotion(actor.simulation);
    const location = { ...actor.profile.location };
    world.adoptResumedMotion(actor, walked);
    expect(captureMotion(actor.simulation)).toEqual(before);
    expect(actor.profile.location).toEqual(location);
    expect(faults(probe)).toEqual([]);
  } finally {
    dispose(probe);
  }
});

test("a resume beyond any possible motion is refused", async () => {
  const probe = await fixture();
  try {
    const { field, actor } = probe;
    field.tick = 100;
    actor.lastAdoptedTick = 0;
    const impossible = { x: 900000, y: 0, vx: 0, vy: 0 };
    expect(() => probe.world.adoptResumedMotion(actor, impossible)).toThrow(
      "NOT_ALLOWED",
    );
    expect(actor.simulation.x).not.toBe(impossible.x);
    expect(actor.retiring).toBe(true);
  } finally {
    dispose(probe);
  }
});

for (const value of ["false", "true"]) {
  test(`configured watchdog ${value} cannot disable trajectory validation`, async () => {
    const config = serverConfig({
      DATABASE_URL: "postgres://unused.invalid/watchdog_test",
      OPENMS_MOTION_WATCHDOG_ENABLED: value,
    });
    const probe = await fixture(100000000, config.watchdogEnabled);
    try {
      const { world, actor } = probe;
      place(actor, 0, 0);
      world.moveActor(actor);
      const report = { x: 10000, y: 0, vx: 0, vy: 0 };
      world.input(actor, input(actor, report));
      advance(probe, 1);
      expect(actor.simulation.previousX).not.toBe(report.x);
      expect(Boolean(actor.retiring)).toBe(true);
      expect(faults(probe).length > 0).toBe(true);
      if (!config.watchdogEnabled) {
        expect(world.watchdog.snapshot()).toEqual({
          enabled: false,
          reviewed: 0,
          suspicious: 0,
          faults: 0,
          actors: [],
        });
      }
    } finally {
      dispose(probe);
    }
  });
}

test("disabled watchdog still cannot grant position through reconnect", async () => {
  const probe = await fixture(100000000, false);
  try {
    const { world, actor } = probe;
    place(actor, 0, 0);
    const report = { x: 10000, y: 0, vx: 0, vy: 0 };
    const location = { ...actor.profile.location };
    world.adoptResumedMotion(actor, report);
    expect(actor.simulation.x).toBe(0);
    expect(actor.profile.location).toEqual(location);
    world.adoptResumedMotion(actor, { ...report, x: NaN });
    expect(actor.simulation.x).toBe(0);
    actor.simulation.seat = { x: 10000, y: 0 };
    world.adoptResumedMotion(actor, { ...report, x: 20000 });
    expect(actor.simulation.x).toBe(0);
    expect(Boolean(actor.retiring)).toBe(false);
    expect(faults(probe)).toEqual([]);
    expect(world.watchdog.snapshot().actors).toEqual([]);
  } finally {
    dispose(probe);
  }
});

test("position tolerance scales with elapsed time and velocity does not", () => {
  expect(MOTION_PLAUSIBILITY.minimumPositionPx).toBe(32);
  expect(plausiblePositionPx(0)).toBe(450);
  expect(plausiblePositionPx(30)).toBe(477);
  expect(plausiblePositionPx(100)).toBeCloseTo(540, 6);
  expect(plausiblePositionPx(Number.NaN)).toBe(32);
  expect(plausiblePositionPx(-5)).toBe(450);
  expect(MOTION_PLAUSIBILITY.velocityPxPerSecond).toBe(700);
});

test("server-owned position is limited to transitions, seats and unpredicted movement skills", async () => {
  const probe = await fixture();
  try {
    const { actor } = probe;
    expect(serverOwnsPosition(actor, actor.simulation)).toBe(false);
    actor.simulation.seat = { x: 0, y: 0 };
    expect(serverOwnsPosition(actor, actor.simulation)).toBe(true);
    actor.simulation.seat = null;
    actor.skills.worldController.rush.remainingMs = 100;
    expect(serverOwnsPosition(actor, actor.simulation)).toBe(true);
    actor.skills.worldController.rush.remainingMs = 0;
    actor.skills.worldController.teleportMs = 90;
    expect(serverOwnsPosition(actor, actor.simulation)).toBe(true);
    actor.skills.worldController.teleportMs = 0;
    actor.simulation.ladder = {};
    expect(serverOwnsPosition(actor, actor.simulation)).toBe(false);
    actor.simulation.ladder = null;
    actor.pending = true;
    expect(serverOwnsPosition(actor, actor.simulation)).toBe(false);
    actor.transition = {};
    expect(serverOwnsPosition(actor, actor.simulation)).toBe(true);
  } finally {
    dispose(probe);
  }
});

test("an ordinary tick publishes an observation while a seat publishes ownership", async () => {
  const probe = await fixture();
  try {
    const { world, field, actor, publications } = probe;
    const lastMotion = () =>
      publications.filter((entry) => entry.message.type === "motion").at(-1)
        .message;
    field.tick += 1;
    world.tickField(field);
    expect(lastMotion().authoritative).toBe(false);
    actor.simulation.seat = { x: actor.simulation.x, y: actor.simulation.y };
    field.tick += 1;
    world.tickField(field);
    expect(lastMotion().authoritative).toBe(true);
  } finally {
    dispose(probe);
  }
});

test("a recorded divert is published on the wire and validates as a server frame", async () => {
  const probe = await fixture();
  try {
    const { world, field, actor, publications } = probe;
    field.tick += 1;
    recordMotionDivert(actor, actor.simulation, {
      vx: 300,
      vy: -250,
      source: "hit",
    });
    field.tick += 1;
    world.publish(actor, {
      type: "motion",
      fieldEpoch: field.epoch,
      ...movementStreamView(actor),
      ackInputSeq: actor.ackInputSeq,
      motion: captureMotion(actor.simulation),
      paused: false,
      authoritative: false,
      diverts: takeMotionDiverts(actor, field),
    });
    const motion = publications.find(
      (entry) => entry.message.type === "motion",
    );
    expect(motion).toBeDefined();
    const divert = motion.message.diverts[0];
    // The published tick is the one that first integrates the impulse; only the event
    // vector, source and skill id cross the wire because the client owns the trajectory.
    expect(divert.tick).toBe(field.tick);
    expect(divert.vx).toBe(300);
    expect(divert.vy).toBe(-250);
    expect(divert.source).toBe("hit");
    expect(divert.skillId).toBe(0);
    // An empty divert list is the ordinary tick, not an omitted field.
    world.publish(actor, {
      type: "motion",
      fieldEpoch: field.epoch,
      ...movementStreamView(actor),
      ackInputSeq: actor.ackInputSeq,
      motion: captureMotion(actor.simulation),
      paused: false,
      authoritative: false,
      diverts: takeMotionDiverts(actor, field),
    });
    expect(publications.at(-1).message.diverts).toEqual([]);
    const frame = (message) =>
      decodeServer(
        JSON.stringify({
          v: 1,
          ...message,
          connectionEpoch: "epoch",
          serverTick: field.tick,
        }),
      );
    expect(frame(motion.message).diverts[0]).toEqual(divert);
    expect(frame(publications.at(-1).message).diverts).toEqual([]);
  } finally {
    dispose(probe);
  }
});

test("the watchdog counts deviations inside one window and forgets an actor", () => {
  const watchdog = new MotionWatchdog({ enabled: true });
  const quiet = {
    position: 1,
    velocity: 1,
    allowedPosition: 32,
    allowedVelocity: 700,
  };
  expect(watchdog.review("a", 1, quiet)).toEqual({
    decision: "accept",
    suspicious: false,
    score: 0,
  });
  const edge = {
    position: 32,
    velocity: 700,
    allowedPosition: 32,
    allowedVelocity: 700,
  };
  expect(watchdog.review("a", 2, edge).suspicious).toBe(false);
  const justOutside = {
    position: 32.5,
    velocity: 700.5,
    allowedPosition: 32,
    allowedVelocity: 700,
  };
  expect(watchdog.review("a", 3, justOutside)).toEqual({
    decision: "accept",
    suspicious: true,
    score: 1,
  });
  for (let episode = 1; episode < WATCHDOG_POLICY.suspicionLimit; episode++) {
    watchdog.review(
      "a",
      3 + episode * WATCHDOG_POLICY.episodeTicks,
      justOutside,
    );
  }
  expect(watchdog.snapshot().faults).toBe(1);
  // Evidence ages out of its window, so an old deviation cannot convict forever.
  expect(watchdog.review("b", 4000, justOutside).decision).toBe("accept");
  expect(watchdog.review("b", 4000 + 900, justOutside).score).toBe(1);
  watchdog.forget("a");
  expect(watchdog.snapshot().actors.map((entry) => entry.id)).toEqual(["b"]);
});

test("a burst of delayed reports is one episode and the logged 200px discrepancy is ordinary", () => {
  const watchdog = new MotionWatchdog({ enabled: true });
  const excess = {
    position: 200,
    velocity: 0,
    allowedPosition: plausiblePositionPx(30),
    allowedVelocity: 700,
  };
  expect(watchdog.review("lag", 1, excess).suspicious).toBe(false);
  excess.position = 800;
  for (let tick = 2; tick < WATCHDOG_POLICY.episodeTicks; tick++) {
    expect(watchdog.review("lag", tick, excess).decision).toBe("accept");
  }
  expect(watchdog.snapshot().actors[0].deviations).toBe(1);
});
