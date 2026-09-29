import { expect, test } from "bun:test";
import { loadContent } from "../src/content.js";
import { OnlineWorld } from "../src/world.js";
import { prepareActorCombat } from "../src/field-combat.js";
import { prepareActorSkills, disposeActorSkills } from "../src/field-skills.js";
import { takeMotionDiverts } from "../src/field-diverts.js";
import { createProfile } from "../../client/src/profile/profile-validation.js";
import { createSimulation } from "../../client/src/physics/simulation.js";
import {
  captureMotion,
  createHeldInput,
  assignHeldInput,
} from "../../shared/motion.js";
import { movementStreamView } from "../src/movement-stream.js";
import { OnlinePrediction } from "../../client/src/online/prediction.js";

const content = await loadContent();

/** Real field, real kernel and the real `moveActor` admission path; only persistence
 *  and mob population are isolated, exactly as `motion-adoption.test.js` does. */
async function fixture() {
  const publications = [];
  const world = new OnlineWorld({
    content,
    database: {},
    publish(actor, message) {
      publications.push({ actor: actor.id, message });
    },
    log() {},
  });
  const field = await world.fieldFor(100000000);
  field.mobs = [];
  const saved = { mapId: field.manifest.id, x: 0, y: 0, facing: 1 };
  const profile = createProfile(saved);
  profile.hp = 100;
  profile.maxHP = 100;
  profile.mp = 10;
  profile.maxMP = 10;
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
  return { world, field, actor, publications };
}

function dispose(probe) {
  for (const entry of probe.world.actors.values()) {
    disposeActorSkills(entry, true);
  }
}

/** The same jump arc on both sides; the server starts airborne so the hit is midair. */
function airborne(sim) {
  sim.y -= 60;
  sim.previousY = sim.y;
  sim.vx = 0;
  sim.vy = -300;
  sim.state = "air";
}

/** A byte-identical client simulation of the server's pre-hit base. */
function cloneSimulation(field, source) {
  const sim = createSimulation(field.manifest.physics, {
    x: source.x,
    y: source.y,
    facing: 1,
  });
  sim.x = source.x;
  sim.y = source.y;
  sim.previousX = source.x;
  sim.previousY = source.y;
  sim.vx = source.vx;
  sim.vy = source.vy;
  sim.state = source.state;
  return sim;
}

function motionMessage(publications) {
  return publications.filter((entry) => entry.message.type === "motion").at(-1)
    .message;
}

/** One mob knockback through the production impulse entry point that every committed
 *  mob hit reaches (`commitHitOutcome` -> `applyHitPresentation` -> `receiveHitImpulse`).
 *  On the server the commit drains asynchronously, so it is merged between field ticks. */
function mobKnockback(actor, direction) {
  actor.skillField.receiveHitImpulse(
    {
      amount: 30,
      direction,
      locallyInitiated: false,
      source: { id: "hit-source" },
    },
    { kind: "ordinary", direction, roll: 0 },
  );
}

/** The transport serializes each sample the instant it is predicted, so a report is
 *  queued for its own tick before the client could possibly have seen the hit. */
function reportSamples(world, field, actor) {
  let sequence = 0;
  return (sample) => {
    sequence++;
    world.input(actor, {
      ...sample,
      motion: { ...sample.motion },
      impulses: structuredClone(sample.impulses),
      fieldEpoch: field.epoch,
      inputSeq: sequence,
    });
    return sequence;
  };
}

/** Present the newest checkpoint and sample the drawn pose around it. */
function sampleFrame(prediction, message, field, tick) {
  const now = performance.now();
  const shown = { x: 0, y: 0 };
  prediction.interpolate(now, shown);
  prediction.observe({
    connectionEpoch: "epoch",
    fieldEpoch: field.epoch,
    serverTick: field.tick,
    motionEpoch: message.motionEpoch,
    motionConfig: message.motionConfig,
    motionTick: message.motionTick,
    ackInputSeq: message.ackInputSeq,
    paused: false,
    motion: message.motion,
    authoritative: message.authoritative === true,
    diverts: message.diverts,
  });
  const drawn = { x: 0, y: 0 };
  prediction.interpolate(now, drawn);
  const glide = [];
  for (let step = 30; step <= 600; step += 30) {
    const frame = { x: 0, y: 0 };
    prediction.interpolate(now + step, frame);
    glide.push(frame);
  }
  return {
    tick,
    message,
    shown,
    drawn,
    glide,
    motion: captureMotion(prediction.simulation),
  };
}

/** Lockstep server and client: the client predicts `lead` ticks ahead and the server
 *  consumes the very samples it sent, so the only difference is the authoritative
 *  impulse. Every checkpoint returns through the real predictor boundary. */
async function lockstep({ lead, ticks, hitAfter }) {
  const probe = await fixture();
  const { world, field, actor } = probe;
  world.moveActor(actor);
  airborne(actor.simulation);
  const prediction = new OnlinePrediction({
    onInput: reportSamples(world, field, actor),
  });
  prediction.install(cloneSimulation(field, actor.simulation), 0);
  prediction.observe({
    connectionEpoch: "epoch",
    fieldEpoch: field.epoch,
    serverTick: 0,
    ...movementStreamView(actor),
    ackInputSeq: null,
    paused: false,
    motion: captureMotion(actor.simulation),
    diverts: [],
  });
  const held = createHeldInput();
  const neutral = { horizontal: 0, vertical: 0, jump: false, attack: false };
  const presented = [];
  for (let target = 1; target <= ticks; target++) {
    while (prediction.predictedTick < target - 1 + lead) {
      assignHeldInput(held, neutral);
      expect(prediction.predict(held, true)).toBe(true);
    }
    world.tickField(field);
    if (target === hitAfter) mobKnockback(actor, 1);
    presented.push(
      sampleFrame(prediction, motionMessage(probe.publications), field, target),
    );
  }
  return { ...probe, prediction, presented };
}

test("a midair mob knockback merges once into the local path and validates after delayed delivery", async () => {
  const hitAfter = 3;
  const divertTick = hitAfter + 1;
  const result = await lockstep({ lead: 4, ticks: 8, hitAfter });
  try {
    const messages = result.publications
      .filter((entry) => entry.message.type === "motion")
      .map((entry) => entry.message);
    const divertMessage = messages[divertTick - 1];
    // A committed hit must describe itself: one divert carrying the exact vector and
    // its source, so the browser can merge it into its own kernel.
    expect(divertMessage.diverts).toHaveLength(1);
    const divert = divertMessage.diverts[0];
    expect(divert.tick).toBe(divertTick);
    expect(divert.source).toBe("hit");
    expect(divert.sourceId).toBe("hit-source");
    expect(divert.vx).toBe(270);
    expect(divert.vy).toBe(-270);
    expect(divert.skillId).toBe(0);
    expect(result.prediction.snapshot().diverts).toBe(1);
    expect(result.prediction.snapshot().corrections).toBe(0);
    expect(result.prediction.snapshot().replayedTicks).toBe(0);
    for (let count = 0; count < 4; count++) {
      result.world.tickField(result.field);
    }
    expect(result.actor.retiring).not.toBe(true);
    expect(result.actor.inputQueue.size).toBe(0);
    const local = result.prediction.simulation;
    expect(result.actor.simulation.x).toBe(local.x);
    expect(result.actor.simulation.y).toBe(local.y);
    expect(result.actor.simulation.vx).toBe(local.vx);
    expect(result.actor.simulation.vy).toBe(local.vy);
  } finally {
    dispose(result);
  }
});

test("an impulse merged after its own step publishes for the tick that integrates it", async () => {
  const probe = await fixture();
  try {
    const { field, actor } = probe;
    field.tick += 1;
    // A hit committed during the tick, after that tick's kernel step: the next step merges it.
    actor.motionDiverts.entries.push({
      vx: 200,
      vy: -100,
      source: "hit",
      skillId: 0,
      tick: field.tick,
    });
    expect(takeMotionDiverts(actor, field)).toEqual([]);
    expect(actor.motionDiverts.entries).toHaveLength(1);
    field.tick += 1;
    expect(takeMotionDiverts(actor, field)).toEqual([
      { tick: field.tick, vx: 200, vy: -100, source: "hit", skillId: 0 },
    ]);
    expect(actor.motionDiverts.entries).toEqual([]);
  } finally {
    dispose(probe);
  }
});
