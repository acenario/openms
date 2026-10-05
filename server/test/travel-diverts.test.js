import { expect, test } from "bun:test";
import { content } from "./party-fixture.js";
import { OnlineWorld } from "../src/world.js";
import { prepareActorCombat } from "../src/field-combat.js";
import { disposeActorSkills, prepareActorSkills } from "../src/field-skills.js";
import { prepareActorWorldActions } from "../src/field-world-actions.js";
import { transitionActor } from "../src/field-transition.js";
import { recordMotionDivert, takeMotionDiverts } from "../src/field-diverts.js";
import { actorEntity } from "../src/field-views.js";
import { createProfile } from "../../client/src/profile/profile-validation.js";
import { PROTOCOL, plausiblePositionPx } from "../../shared/protocol.js";

/** A joined actor on a real field; persistence runs the operation's own mutate on a draft. */
async function joined(mapId, { watchdogEnabled = false, tick = 0 } = {}) {
  const world = new OnlineWorld({
    content,
    database: { bindField: async () => {} },
    watchdogEnabled,
    publish() {},
  });
  const source = await world.fieldFor(mapId);
  source.mobs = [];
  source.tick = tick;
  const profile = createProfile({
    mapId: source.manifest.id,
    x: 0,
    y: 0,
    facing: 1,
  });
  Object.assign(profile, {
    hp: 100,
    maxHP: 100,
    mp: 10,
    maxMP: 10,
    onlineState: { effects: [], cooldowns: {} },
  });
  const actor = {
    id: "traveler",
    profile,
    revision: 0,
    session: { expiresAt: Date.now() + 60000 },
  };
  world.participants.commit = async (_actor, _operation, _ids, mutate) => {
    const drafts = new Map([[actor.id, structuredClone(actor.profile)]]);
    return { status: "committed", code: "OK", ...(await mutate(drafts)) };
  };
  world.prepareEntry(actor, source);
  prepareActorCombat(world, actor);
  await prepareActorSkills(world, actor);
  await prepareActorWorldActions(world, actor);
  source.characters.set(actor.id, actor);
  world.actors.set(actor.id, actor);
  actor.state = "active";
  actor.connection = {
    data: { ready: true, transfer: null, baselines: new Map() },
  };
  return { world, actor };
}

/** Drive the real packet transition through its client-ready gate. */
async function travel(world, actor, mapId, portal) {
  const pending = transitionActor(
    world,
    actor,
    portal === undefined ? { mapId } : { mapId, portal },
    { operationId: "travel" },
  );
  for (let i = 0; i < 200 && !actor.transition?.ready; i++) {
    await Bun.sleep(5);
  }
  if (!actor.transition?.ready) await pending;
  actor.transition.ready(true);
  expect((await pending).status).toBe("committed");
  expect(actor.field.mapId).toBe(mapId);
}

/** An unannounced impulse grant expires unreferenced and faults the next movement step. */
test("a mob-hit divert after cross-map travel is announced on the destination field", async () => {
  const { world, actor } = await joined(100000000);
  try {
    await travel(world, actor, 104000000);

    recordMotionDivert(actor, actor.simulation, {
      vx: 120,
      vy: -270,
      source: "hit",
      skillId: 0,
      sourceId: "mob",
    });
    const grants = actor.movementStream.grants.map((grant) => grant.id);
    expect(grants.length).toBe(1);
    actor.field.tick++;
    const published = takeMotionDiverts(actor, actor.field);
    expect(published.map((divert) => divert.id)).toEqual(grants);
  } finally {
    disposeActorSkills(actor, true);
  }
});

/** Every field counts its own ticks from creation; a long-lived source field's clock
 *  must not survive into a fresh destination's reconnect allowance or peer animation. */
test("a reconnect after cross-map travel is judged on the destination clock", async () => {
  const { world, actor } = await joined(100000000, {
    watchdogEnabled: true,
    tick: 100000,
  });
  try {
    await travel(world, actor, 104000000);
    // Three seconds of honest walking whose inputs were lost with the socket.
    const gapTicks = 100;
    actor.field.tick += gapTicks;
    const sim = actor.simulation;
    const walked = { x: sim.x + 600, y: sim.y, vx: 0, vy: 0 };
    expect(plausiblePositionPx(gapTicks * PROTOCOL.TICK_MS)).toBeGreaterThan(
      600,
    );
    world.adoptResumedMotion(actor, walked);
    expect(world.watchdog.snapshot().suspicious).toBe(0);
    expect(actorEntity(actor).actionStartTick).toBeLessThanOrEqual(
      actor.field.tick,
    );
  } finally {
    disposeActorSkills(actor, true);
  }
});

/** Original 910300000/out00 names 103000000 "hide01", which Kerning City lacks;
 *  Cosmic GenericPortal enters `to.getPortal(target) ?? to.getPortal(0)`. */
test("a destination portal name absent from the target map arrives at portal 0", async () => {
  const { world, actor } = await joined(910300000);
  try {
    const out00 = actor.field.manifest.physics.portals.find(
      (portal) => portal.name === "out00",
    );
    expect(out00).toMatchObject({ targetMap: 103000000, targetName: "hide01" });
    await travel(world, actor, 103000000, out00.targetName);
    const portals = actor.field.manifest.physics.portals;
    expect(portals.some((portal) => portal.name === "hide01")).toBe(false);
    const spawn = portals.find((portal) => portal.id === 0);
    expect(actor.simulation.x).toBe(spawn.x);
  } finally {
    disposeActorSkills(actor, true);
  }
});
