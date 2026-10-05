// Check: a mob-hit impulse grant issued after a cross-map transition must be published to
// the client as a motion divert. Unannounced grants expire unreferenced and the next accepted
// movement step faults with motion.fault {position:0, velocity:0} => close 1011 NOT_ALLOWED.
//   bun agent/divert-travel-check.js        exit 0 = pass, 1 = the bug is present
// Real OnlineWorld, real transitionActor/bindTransition, real recordMotionDivert/takeMotionDiverts;
// only persistence (participants.commit) and the socket are stubbed, as server/test fixtures do.
import { loadContent } from "../../server/src/content.js";
import { OnlineWorld } from "../../server/src/world.js";
import { prepareActorCombat } from "../../server/src/field-combat.js";
import { prepareActorSkills, disposeActorSkills } from "../../server/src/field-skills.js";
import { prepareActorWorldActions } from "../../server/src/field-world-actions.js";
import { transitionActor } from "../../server/src/field-transition.js";
import { recordMotionDivert, takeMotionDiverts } from "../../server/src/field-diverts.js";
import { createProfile } from "../client/src/profile/profile-validation.js";

const SOURCE_MAP = 100000000;
const TARGET_MAP = 104000000;

const world = new OnlineWorld({ content: await loadContent(), database: { bindField: async () => {} }, publish() {}, log() {} });
const source = await world.fieldFor(SOURCE_MAP);
source.mobs = [];
const profile = createProfile({ mapId: source.manifest.id, x: 0, y: 0, facing: 1 });
Object.assign(profile, { hp: 100, maxHP: 100, mp: 10, maxMP: 10, onlineState: { effects: [], cooldowns: {} } });
const actor = { id: "traveler", profile, revision: 0, session: { expiresAt: Date.now() + 60000 } };
// Persistence stub: run the operation's own mutate against a draft and commit it.
world.participants.commit = async (_actor, _operation, _ids, mutate) => {
  const outcome = await mutate(new Map([[actor.id, structuredClone(actor.profile)]]));
  return { status: "committed", code: "OK", ...outcome };
};
// joinField minus persistence/social: the entry steps travel depends on.
world.prepareEntry(actor, source);
prepareActorCombat(world, actor);
await prepareActorSkills(world, actor);
await prepareActorWorldActions(world, actor);
source.characters.set(actor.id, actor);
world.actors.set(actor.id, actor);
actor.state = "active";
actor.connection = { data: { ready: true, transfer: null, baselines: new Map() } };
const travel = transitionActor(world, actor, { mapId: TARGET_MAP }, { operationId: "check" });
for (let i = 0; i < 200 && !actor.transition?.ready; i++) await Bun.sleep(5);
if (!actor.transition?.ready) await travel; // surfaces the travel error
actor.transition.ready(true); // the client's transition-ready
const receipt = await travel;
if (receipt.status !== "committed" || actor.field.mapId !== TARGET_MAP) throw new Error(`travel did not commit: ${JSON.stringify(receipt)}`);

// What the combat hook does on a mob hit (server/src/skill-hooks.js onExternalImpulse).
recordMotionDivert(actor, actor.simulation, { vx: 120, vy: -270, source: "hit", skillId: 0, sourceId: "mob" });
const grants = actor.movementStream.grants.map((g) => g.id);
actor.field.tick++;
const published = takeMotionDiverts(actor, actor.field).map((d) => d.id);
for (const entry of world.actors.values()) disposeActorSkills(entry, true);

const unannounced = grants.filter((id) => !published.includes(id));
console.log(JSON.stringify({ map: actor.field.mapId, grants, published, unannounced }));
if (!grants.length) throw new Error("no grant issued; check is not exercising the hit path");
if (unannounced.length) {
  console.log("FAIL: impulse grant issued after travel but never published (motionDiverts still bound to the join field)");
  process.exit(1);
}
console.log("PASS");
process.exit(0);
