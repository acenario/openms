import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { compileNpcScript } from "../tools/npc-script-compiler.js";
import { NpcScriptSession } from "../src/npc/npc-script-runtime.js";
import { createProfile } from "../src/profile/profile-validation.js";
import { ProfileStore } from "./fixtures/memory-profile-store.js";

// Vendored Cosmic scripts, compiled exactly as conversion does.
const ROOT = new URL("../../infra/gameplay-definitions/", import.meta.url);
const POLICY = JSON.parse(readFileSync(new URL("policy.json", ROOT), "utf8"));
const BASE_ITEMS = {
  1040002: { id: 1040002, descriptor: {}, info: { islot: "Ma" } },
  1060002: { id: 1060002, descriptor: {}, info: { islot: "Pn" } },
  1072001: { id: 1072001, descriptor: {}, info: { islot: "So" } },
  1302000: { id: 1302000, descriptor: {}, info: { islot: "Wp" } },
};

function compile(npcId) {
  const text = readFileSync(new URL(`npc/${npcId}.js`, ROOT), "utf8");
  const artifact = compileNpcScript({
    text,
    path: `scripts/npc/${npcId}.js`,
    sha256: createHash("sha256").update(text).digest("hex"),
    staticConfig: POLICY.staticConfig,
    originalQuestIds: new Set(),
  });
  expect(artifact.blockers).toEqual([]);
  return artifact;
}

function environmentFor(npcId, artifact, items, travels) {
  const environment = {
    npcId,
    items,
    quests: { schemaVersion: 1, records: {} },
    names: { npc: { [npcId]: `NPC ${npcId}` }, item: {}, mob: {} },
    mapNames: {},
    portraits: { [npcId]: {} },
    shops: {},
    artwork: new Set(),
    artworkMetadata: {},
    random: () => 0,
    isCurrent: () => true,
    isBusy: () => false,
    prepareTravel: async (destination) => {
      travels.push(destination);
      return {
        isCurrent: () => true,
        apply: (draft) => {
          draft.location.mapId = String(destination.mapId).padStart(9, "0");
        },
        publish: () => {},
        release: () => {},
      };
    },
  };
  for (const id of artifact.dependencies.npcIds) {
    environment.names.npc[id] = `NPC ${id}`;
  }
  for (const id of artifact.dependencies.itemIds) {
    environment.names.item[id] = `Item ${id}`;
  }
  for (const id of artifact.dependencies.mapIds) {
    environment.mapNames[id] = `Map ${id}`;
  }
  return environment;
}

/** One character store shared by every NPC session in a flow. */
function character({ level = 30, job = 100, mapId = "102000003" } = {}) {
  const items = { ...BASE_ITEMS };
  const profile = createProfile({ mapId, x: 0, y: 0, facing: 1 });
  profile.level = level;
  profile.job = job;
  return { items, travels: [], store: ProfileStore.memory(profile, { items }) };
}

function talk(owner, npcId) {
  const artifact = compile(npcId);
  for (const id of artifact.dependencies.itemIds) {
    owner.items[id] ??= { id, descriptor: {}, info: { slotMax: 100 } };
  }
  return new NpcScriptSession(
    artifact,
    owner.store,
    environmentFor(npcId, artifact, owner.items, owner.travels),
  );
}

test("a level-30 warrior below the class cap reaches Dances with Balrog's 2nd-job dialogue", async () => {
  const owner = character();
  try {
    const result = await talk(owner, 1022000).start();
    expect(result.ok).toBe(true);
    expect(result.view.text).toContain("The progress you have made");
  } finally {
    await owner.store.destroy();
  }
});

test("a capped character still needs the unavailable Hall-of-Fame registry", async () => {
  const owner = character({ level: 200, job: 112 });
  try {
    const result = await talk(owner, 1022000).start();
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("hall-of-fame-player-npc");
  } finally {
    await owner.store.destroy();
  }
});
