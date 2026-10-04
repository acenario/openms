import { afterEach } from "bun:test";
import { loadContent } from "../src/content.js";
import { OnlineWorld } from "../src/world.js";
import {
  prepareActorSkills,
  synchronizeActorSkills,
  disposeActorSkills,
} from "../src/field-skills.js";
import { prepareActorCombat } from "../src/field-combat.js";
import { createProfile } from "../../client/src/profile/profile-validation.js";
import { recalculateVitals } from "../../client/src/character/character-stats.js";
import { COMBAT_RESULT_SCHEMAS } from "../../shared/combat-protocol.js";
import { validate } from "../../shared/schema.js";

export const content = await loadContent();
const worlds = [];

afterEach(() => {
  for (const world of worlds.splice(0)) {
    for (const actor of world.actors.values()) disposeActorSkills(actor, true);
  }
});

/** Real content, skill costs, controllers and restoration; persistence is isolated in a test store. */
export async function fixture(
  job = 232,
  learned = [2301002, 2311001, 2321006],
  mapId = 100000000,
) {
  const world = new OnlineWorld({ content, database: {}, publish() {} });
  worlds.push(world);
  const field = await world.fieldFor(mapId);
  const saved = new Map();
  const actors = [];
  for (let index = 0; index < 4; index++) {
    const profile = createProfile({
      mapId: field.manifest.id,
      x: 0,
      y: 0,
      facing: 1,
    });
    Object.assign(profile, {
      job: index === 0 ? job : 0,
      level: 120,
      baseMaxHP: 1000,
      baseMaxMP: 2000,
    });
    if (index === 0) {
      for (const id of learned) {
        profile.skills[id] = {
          level: content.catalog.ui.skills[id].maxLevel,
          masterLevel: content.catalog.ui.skills[id].maxLevel,
          expiresAt: null,
        };
      }
    }
    recalculateVitals(profile, content.items);
    profile.hp = 100;
    profile.mp = profile.maxMP;
    profile.onlineState = { effects: [], cooldowns: {} };
    const actor = {
      id: crypto.randomUUID(),
      profile,
      revision: 0,
      session: { expiresAt: Date.now() + 60000 },
    };
    world.prepareEntry(actor, field);
    prepareActorCombat(world, actor);
    await prepareActorSkills(world, actor);
    actor.state = "active";
    actor.simulation.x = index === 2 ? 10000 : 0;
    actor.simulation.y = 0;
    field.characters.set(actor.id, actor);
    world.actors.set(actor.id, actor);
    actors.push(actor);
    saved.set(actor.id, structuredClone(profile));
  }
  joinParty(actors);
  installTransactions(world, saved);
  return { world, actors, saved };
}

function installTransactions(world, saved) {
  const receipts = new Map();
  world.participants.commitProduced = (caster, operation, cohort, mutate) =>
    world.participants.commit(
      caster,
      operation,
      [caster.id, ...cohort(caster.profile)],
      mutate,
    );
  world.participants.commit = async (caster, operation, ids, mutate) => {
    if (receipts.has(operation.operationId)) {
      return receipts.get(operation.operationId);
    }
    const unique = [...new Set(ids)];
    const drafts = new Map(
      unique.map((id) => [id, structuredClone(world.actors.get(id).profile)]),
    );
    const result = await mutate(drafts);
    validate(result.value, COMBAT_RESULT_SCHEMAS[result.value.kind]);
    for (const [id, profile] of drafts) {
      saved.set(id, structuredClone(profile));
      const actor = world.actors.get(id);
      actor.profile = profile;
      actor.revision++;
      await synchronizeActorSkills(world, actor);
    }
    const receipt = { status: "committed", ...result };
    receipts.set(operation.operationId, receipt);
    return receipt;
  };
}

function joinParty(actors) {
  const party = {
    id: "party",
    leaderId: actors[0].id,
    members: actors.slice(0, 3).map((actor) => actor.id),
  };
  for (const actor of actors.slice(0, 3)) {
    actor.profile.social.party = structuredClone(party);
  }
}
