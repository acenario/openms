import { expect, test } from "bun:test";
import { content } from "./party-fixture.js";
import { OnlineWorld } from "../src/world.js";
import { prepareActorCombat } from "../src/field-combat.js";
import { disposeActorSkills, prepareActorSkills } from "../src/field-skills.js";
import { prepareActorWorldActions } from "../src/field-world-actions.js";
import { transitionActor } from "../src/field-transition.js";
import { recordMotionDivert, takeMotionDiverts } from "../src/field-diverts.js";
import { createProfile } from "../../client/src/profile/profile-validation.js";

/** A joined actor on a real field; persistence runs the operation's own mutate on a draft. */
async function joined(mapId) {
  const world = new OnlineWorld({
    content,
    database: { bindField: async () => {} },
    publish() {},
  });
  const source = await world.fieldFor(mapId);
  source.mobs = [];
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

/** An unannounced impulse grant expires unreferenced and faults the next movement step. */
test("a mob-hit divert after cross-map travel is announced on the destination field", async () => {
  const { world, actor } = await joined(100000000);
  try {
    const travel = transitionActor(
      world,
      actor,
      { mapId: 104000000 },
      { operationId: "travel" },
    );
    for (let i = 0; i < 200 && !actor.transition?.ready; i++) {
      await Bun.sleep(5);
    }
    if (!actor.transition?.ready) await travel;
    actor.transition.ready(true);
    expect((await travel).status).toBe("committed");
    expect(actor.field.mapId).toBe(104000000);

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
