import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import source from "./fixtures/npc-dark-lord-source.json";
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
const BASE_ITEMS = {
  1040002: { id: 1040002, descriptor: {}, info: { islot: "Ma" } },
  1060002: { id: 1060002, descriptor: {}, info: { islot: "Pn" } },
  1072001: { id: 1072001, descriptor: {}, info: { islot: "So" } },
  1302000: { id: 1302000, descriptor: {}, info: { islot: "Wp" } },
};

function compile(text = source.text, config = CONFIG) {
  return compileNpcScript({
    text,
    path: source.source,
    sha256: createHash("sha256").update(text).digest("hex"),
    staticConfig: config,
    originalQuestIds: new Set([6141]),
  });
}

function setup(options = {}) {
  const artifact = compile(source.text, options.config ?? CONFIG);
  expect(artifact.blockers).toEqual([]);
  const items = { ...BASE_ITEMS };
  for (const id of artifact.dependencies.itemIds) {
    items[id] = { id, descriptor: {}, info: { slotMax: 1000 } };
  }
  const profile = createProfile({ mapId: "103000003", x: 0, y: 0, facing: 1 });
  profile.level = options.level ?? 10;
  profile.dex = options.dex ?? 25;
  profile.remainingAp = 25;
  profile.inventorySlots[0] = options.equipSlots ?? 24;
  profile.skills[1001] = { level: 1, masterLevel: 0, expiresAt: null };
  const store = ProfileStore.memory(profile, { items });
  const environment = {
    npcId: 1052001,
    items,
    quests: { schemaVersion: 1, records: { 6141: { id: 6141 } } },
    names: { npc: { 1052001: "Dark Lord" }, item: {}, mob: {} },
    mapNames: {},
    portraits: { 1052001: {} },
    shops: {},
    artwork: new Set(),
    artworkMetadata: {},
    isCurrent: () => true,
    isBusy: () => false,
    prepareTravel: async () => {
      throw new Error("Unexpected travel in first job flow");
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
    artifact,
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

async function offer(session) {
  expect((await session.start()).ok).toBe(true);
  const result = await respond(session, "next");
  expect(result.ok).toBe(true);
  return result;
}

test("real Dark Lord advancement conserves AP, grants job rewards atomically, and preserves learned skills", async () => {
  const { store, session, items } = setup();
  const before = structuredClone(store.profile);
  try {
    expect((await offer(session)).view.kind).toBe("yes-no");
    expect((await respond(session, "yes")).ok).toBe(true);
    const profile = store.profile;
    expect(profile.job).toBe(400);
    expect([profile.str, profile.dex, profile.int, profile.luk]).toEqual([
      4, 25, 4, 4,
    ]);
    expect(
      profile.remainingAp +
        profile.str +
        profile.dex +
        profile.int +
        profile.luk,
    ).toBe(
      before.remainingAp + before.str + before.dex + before.int + before.luk,
    );
    expect(profile.remainingSp[0]).toBe(1);
    expect(profile.skills).toEqual(before.skills);
    expect(profile.inventorySlots[0]).toBe(28);
    expect(profile.baseMaxHP - before.baseMaxHP).toBeGreaterThanOrEqual(100);
    expect(profile.baseMaxHP - before.baseMaxHP).toBeLessThanOrEqual(150);
    expect(profile.baseMaxMP - before.baseMaxMP).toBeGreaterThanOrEqual(25);
    expect(profile.baseMaxMP - before.baseMaxMP).toBeLessThanOrEqual(50);
    expect(itemCount(profile, 2070015)).toBe(500);
    expect(itemCount(profile, 1472061)).toBe(1);
    expect(itemCount(profile, 1332063)).toBe(1);
    const saved = JSON.parse(JSON.stringify(profile));
    validateProfile(saved, items);
    expect(saved).toEqual(profile);
  } finally {
    await store.destroy();
  }
});

test("Dark Lord refuses low level and manual-AP dexterity shortfall before giving the offer", async () => {
  for (const options of [
    { level: 9 },
    { dex: 24, config: { ...CONFIG, USE_AUTOASSIGN_STARTERS_AP: false } },
  ]) {
    const { store, session } = setup(options);
    const before = structuredClone(store.profile);
    try {
      const result = await offer(session);
      expect(result.view.disposed).toBe(true);
      expect(store.profile).toEqual(before);
    } finally {
      await store.destroy();
    }
  }
});

test("two equipment rewards require two slots together and refusal never partially advances", async () => {
  const { store, session } = setup({ equipSlots: 1 });
  const before = structuredClone(store.profile);
  try {
    await offer(session);
    expect((await respond(session, "yes")).view.disposed).toBe(true);
    expect(store.profile).toEqual(before);
  } finally {
    await store.destroy();
  }
});

test("failed advancement commit preserves the offer and retry cannot duplicate rewards", async () => {
  const { store, session } = setup();
  const before = structuredClone(store.profile);
  try {
    await offer(session);
    store.revision = Number.MAX_SAFE_INTEGER;
    expect((await respond(session, "yes")).ok).toBe(false);
    expect(store.profile).toEqual(before);
    expect(session.view.kind).toBe("yes-no");
    store.revision = 0;
    expect((await respond(session, "yes")).ok).toBe(true);
    expect(itemCount(store.profile, 2070015)).toBe(500);
    expect(store.profile.remainingSp[0]).toBe(1);
  } finally {
    await store.destroy();
  }
});

test("pure GameConstants calls use scalar jobs while reached server operations roll back earlier effects", async () => {
  const { store, environment } = setup();
  const pure = compile(`function start() {
    const Rules = Java.type('constants.game.GameConstants');
    if (Rules.getHallOfFameMapid(cm.getJob()) === 130000110 &&
        Rules.isCygnus(1400) && Rules.isAran(2112) && Rules.getSkillBook(2218) === 9 &&
        parseInt(499 / 100) === 4) cm.gainMeso(7);
    cm.dispose();
  }`);
  const remote = compile(
    `function start() { cm.gainMeso(20); cm.startQuest(100200); cm.dispose(); }`,
  );
  try {
    expect(pure.blockers).toEqual([]);
    expect(
      (await new NpcScriptSession(pure, store, environment).start()).ok,
    ).toBe(true);
    expect(store.profile.meso).toBe(7);
    expect(
      (await new NpcScriptSession(remote, store, environment).start()).ok,
    ).toBe(false);
    expect(store.profile.meso).toBe(7);
    expect(store.profile.quests).toEqual({});
  } finally {
    await store.destroy();
  }
});
