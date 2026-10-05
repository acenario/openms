import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { loadContent } from "../src/content.js";
import { executeNpc } from "../src/interaction-npc.js";
import { npcReferences } from "../src/interaction-npc-content.js";
import { compileNpcScript } from "../../client/tools/npc-script-compiler.js";
import {
  createProfile,
  validateProfile,
} from "../../client/src/profile/profile-validation.js";
import {
  grantItem,
  itemCount,
} from "../../client/src/items/inventory-model.js";

const content = await loadContent();
const items = content.catalog.ui.items;
const ROOT = new URL("../../infra/gameplay-definitions/", import.meta.url);
const POLICY = JSON.parse(readFileSync(new URL("policy.json", ROOT), "utf8"));
const ORIGINAL_QUESTS = new Set(
  Object.keys(content.catalog.quests.records).map(Number),
);
// Dances with Balrog, the Perion job instructor and the inside instructor.
const NPCS = [1022000, 1072000, 1072004];

/** Compile from the vendored sources so the test does not depend on a re-extraction. */
function compiledRoute(previous, npcId) {
  const text = readFileSync(new URL(`npc/${npcId}.js`, ROOT), "utf8");
  const compilation = compileNpcScript({
    text,
    path: `scripts/npc/${npcId}.js`,
    sha256: createHash("sha256").update(text).digest("hex"),
    staticConfig: POLICY.staticConfig,
    originalQuestIds: ORIGINAL_QUESTS,
  });
  expect(compilation.blockers).toEqual([]);
  return { ...previous, ...compilation };
}

/** The real executeNpc path (worker VM, replay, leases) over a stub persistence boundary. */
async function fixture() {
  const field = { epoch: crypto.randomUUID(), characters: new Map() };
  const profile = createProfile({ mapId: "102000003", x: 0, y: 0, facing: 1 });
  Object.assign(profile, { level: 30, job: 100, str: 35, remainingAp: 0 });
  profile.inventorySlots = [28, 28, 28, 28, profile.inventorySlots[4]];
  const actor = {
    id: crypto.randomUUID(),
    accountId: crypto.randomUUID(),
    session: { expiresAt: Date.now() + 60000 },
    state: "active",
    field,
    profile,
    revision: 1,
  };
  field.characters.set(actor.id, actor);
  const travels = [];
  async function commit(mutate, destination) {
    const drafts = new Map([[actor.id, structuredClone(actor.profile)]]);
    const result = await mutate(drafts);
    const draft = drafts.get(actor.id);
    if (destination) {
      travels.push(destination);
      draft.location.mapId = String(destination.mapId).padStart(9, "0");
    }
    actor.profile = validateProfile(draft, items);
    return { status: "committed", code: "OK", ...result };
  }
  const world = {
    content,
    actors: new Map([[actor.id, actor]]),
    npc: () => world.current,
    publish: () => {},
    deliveryFailed: (_actor, error) => {
      throw error;
    },
    participants: { commit: (_a, _o, _i, mutate) => commit(mutate) },
    transition: (_actor, destination, { mutate }) =>
      commit(mutate, destination),
  };
  const references = await npcReferences(world);
  for (const id of NPCS) {
    references.routes.set(id, compiledRoute(references.routes.get(id), id));
  }
  return { actor, world, travels };
}

async function send(probe, action) {
  const receipt = await executeNpc(
    probe.actor,
    { expectedRevision: action.step ?? probe.actor.revision, action },
    probe.world,
  );
  expect(receipt).toMatchObject({ status: "committed" });
}

async function open(probe, templateId) {
  probe.world.current = { id: `npc:${templateId}`, templateId };
  await send(probe, { kind: "npc.open", npcId: probe.world.current.id });
  if (probe.actor.conversation?.menu) await answer(probe, "choice", 0);
}

function answer(probe, kind, value) {
  const lease = probe.actor.conversation;
  const reply =
    kind === "choice"
      ? { kind, choiceId: value }
      : kind === "yesno"
        ? { kind, value }
        : { kind };
  return send(probe, {
    kind: "npc.answer",
    conversationId: lease.id,
    step: lease.step,
    answer: reply,
  });
}

async function walk(probe, templateId, answers) {
  await open(probe, templateId);
  for (const [kind, value] of answers) await answer(probe, kind, value);
  expect(probe.actor.conversation).toBeNull();
}

test("a level-30 warrior walks the Cosmic 2nd-job chain to Fighter through the server NPC path", async () => {
  const probe = await fixture();
  const start = structuredClone(probe.actor.profile);
  // Dances with Balrog: letter and custom quest 100003.
  await walk(probe, 1022000, [["next"], ["next"], ["next"]]);
  expect(probe.actor.profile.quests[100003].state).toBe(1);
  expect(itemCount(probe.actor.profile, 4031008)).toBe(1);
  // Perion job instructor: letter taken, 100003 → 100004, into the test map.
  await walk(probe, 1072000, [
    ["next"],
    ["next"],
    ["next"],
    ["yesno", true],
    ["next"],
  ]);
  expect(probe.travels.at(-1)).toEqual({
    kind: "warp",
    mapId: 108000300,
    portal: 0,
  });
  expect(itemCount(probe.actor.profile, 4031008)).toBe(0);
  expect(probe.actor.profile.quests[100004].state).toBe(1);
  // Test mobs 9000100/9000101 drop Dark Marbles (second-job-content.test.js).
  grantItem(probe.actor.profile, items[4031013], 32);
  await walk(probe, 1072004, [["next"]]);
  expect(probe.travels.at(-1)).toEqual({
    kind: "warp",
    mapId: 102020300,
    portal: 2,
  });
  expect(itemCount(probe.actor.profile, 4031013)).toBe(0);
  expect(itemCount(probe.actor.profile, 4031012)).toBe(1);
  expect(probe.actor.profile.quests[100004].state).toBe(2);
  expect(probe.actor.profile.quests[100005].state).toBe(1);
  // Back at Dances with Balrog: proof → choose Fighter → confirm.
  await open(probe, 1022000);
  await answer(probe, "next");
  await answer(probe, "choice", 3);
  await answer(probe, "choice", 0);
  await answer(probe, "yesno", true);
  const profile = probe.actor.profile;
  expect(profile.job).toBe(110);
  expect(profile.quests[100005].state).toBe(2);
  expect(itemCount(profile, 4031012)).toBe(0);
  expect(profile.remainingSp[1]).toBe(start.remainingSp[1] + 1);
  expect(profile.remainingAp).toBe(start.remainingAp);
  const hp = profile.baseMaxHP - start.baseMaxHP;
  expect(hp >= 300 && hp <= 350).toBe(true);
  expect(profile.baseMaxMP).toBe(start.baseMaxMP);
  expect(profile.inventorySlots.slice(0, 4)).toEqual([32, 32, 32, 32]);
  // Each committed turn runs two bounded worker VMs (plan and replay).
}, 30000);
