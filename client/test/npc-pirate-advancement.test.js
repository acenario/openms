import { expect, test } from "bun:test";
import source from "./fixtures/npc-kyrin-source.json";
import { compileNpcScript } from "../tools/npc-script-compiler.js";
import { NpcScriptSession } from "../src/npc/npc-script-runtime.js";
import {
  createProfile,
  validateProfile,
} from "../src/profile/profile-validation.js";
import { ProfileStore } from "./fixtures/memory-profile-store.js";
import { itemCount } from "../src/items/inventory-model.js";

const CONFIG = {
  USE_AUTOASSIGN_STARTERS_AP: true,
  USE_STARTING_AP_4: false,
  USE_ENFORCE_JOB_SP_RANGE: false,
};
const QUESTS = [2191, 2192, 6330, 6370];
const BASE_ITEMS = {
  1040002: { id: 1040002, descriptor: {}, info: { islot: "Ma" } },
  1060002: { id: 1060002, descriptor: {}, info: { islot: "Pn" } },
  1072001: { id: 1072001, descriptor: {}, info: { islot: "So" } },
  1302000: { id: 1302000, descriptor: {}, info: { islot: "Wp" } },
};

function setup(options = {}) {
  const artifact = compileNpcScript({
    text: source.text,
    path: source.source,
    sha256: source.sha256,
    staticConfig: CONFIG,
    originalQuestIds: new Set(QUESTS),
  });
  expect(artifact.blockers).toEqual([]);
  const items = { ...BASE_ITEMS };
  for (const id of artifact.dependencies.itemIds) {
    items[id] = { id, descriptor: {}, info: { slotMax: 1000 } };
  }
  const profile = createProfile({ mapId: "120000101", x: 0, y: 0, facing: 1 });
  profile.level = options.level ?? 10;
  profile.job = options.job ?? 0;
  profile.remainingAp = 25;
  profile.quests = options.quests ?? {};
  const store = ProfileStore.memory(profile, { items });
  const environment = {
    npcId: 1090000,
    items,
    quests: {
      schemaVersion: 1,
      records: Object.fromEntries(QUESTS.map((id) => [id, { id }])),
    },
    names: { npc: { 1090000: "Kyrin" }, item: {}, mob: {} },
    mapNames: {},
    portraits: { 1090000: {} },
    shops: {},
    artwork: new Set(),
    artworkMetadata: {},
    isCurrent: () => true,
    isBusy: () => false,
    prepareTravel: async () => {
      throw new Error("Unexpected travel in pirate flow");
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
  return {
    store,
    items,
    environment,
    session: new NpcScriptSession(artifact, store, environment),
  };
}

function respond(session, action) {
  return session.respond({
    sessionId: session.sessionId,
    revision: session.view.revision,
    action,
  });
}

test("real Kyrin advancement makes a beginner a pirate with gun, knuckle and bullets", async () => {
  const { store, session, items } = setup();
  const before = structuredClone(store.profile);
  try {
    expect((await session.start()).ok).toBe(true);
    expect((await respond(session, "next")).view.kind).toBe("yes-no");
    expect((await respond(session, "yes")).ok).toBe(true);
    const profile = store.profile;
    expect(profile.job).toBe(500);
    expect([profile.str, profile.dex, profile.int, profile.luk]).toEqual([
      4, 20, 4, 4,
    ]);
    expect(profile.remainingSp[0]).toBe(1);
    expect(profile.skills).toEqual(before.skills);
    expect(itemCount(profile, 1492000)).toBe(1);
    expect(itemCount(profile, 1482000)).toBe(1);
    expect(itemCount(profile, 2330000)).toBe(1000);
    const saved = JSON.parse(JSON.stringify(profile));
    validateProfile(saved, items);
    expect(saved).toEqual(profile);
  } finally {
    await store.destroy();
  }
});

test("Kyrin's reached 4th-job event branch fails before quest or skill effects", async () => {
  const { store, session } = setup({
    level: 120,
    job: 510,
    quests: { 6330: { state: 1, kills: {} } },
  });
  const before = structuredClone(store.profile);
  try {
    const result = await session.start();
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("event-instance");
    expect(store.profile).toEqual(before);
  } finally {
    await store.destroy();
  }
});

test("unavailable if tests skip their branches and random comparisons trap with earlier effects rolled back", async () => {
  const { store, environment } = setup();
  const scripts = {
    "field-population": `function start() { var map = 0; map = 108000501;
      cm.gainMeso(20); if (cm.getPlayerCount(map) > 0) cm.dispose(); else cm.warp(map, 0); }`,
    "random-outcome": `function start() { cm.gainMeso(20);
      var job = (Math.random() < 0.5) ? 510 : 520; cm.changeJobById(job); }`,
  };
  try {
    for (const [service, text] of Object.entries(scripts)) {
      const artifact = compileNpcScript({
        text,
        path: "scripts/npc/test.js",
        sha256: "0".repeat(64),
        staticConfig: CONFIG,
        originalQuestIds: new Set(),
      });
      expect(artifact.blockers).toEqual([]);
      expect(artifact.dependencies.mapIds).toEqual([]);
      const result = await new NpcScriptSession(
        artifact,
        store,
        environment,
      ).start();
      expect(result.ok).toBe(false);
      expect(result.reason).toContain(service);
      expect(store.profile.meso).toBe(0);
    }
  } finally {
    await store.destroy();
  }
});
