import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { compileNpcScript } from "../tools/npc-script-compiler.js";
import { NpcScriptSession } from "../src/npc/npc-script-runtime.js";
import {
  createProfile,
  validateProfile,
} from "../src/profile/profile-validation.js";
import { ProfileStore } from "./fixtures/memory-profile-store.js";
import { grantItem, itemCount } from "../src/items/inventory-model.js";

// Vendored Cosmic scripts, compiled exactly as conversion does.
const ROOT = new URL("../../infra/gameplay-definitions/", import.meta.url);
const POLICY = JSON.parse(readFileSync(new URL("policy.json", ROOT), "utf8"));
const BASE_ITEMS = {
  1040002: { id: 1040002, descriptor: {}, info: { islot: "Ma" } },
  1060002: { id: 1060002, descriptor: {}, info: { islot: "Pn" } },
  1072001: { id: 1072001, descriptor: {}, info: { islot: "So" } },
  1302000: { id: 1302000, descriptor: {}, info: { islot: "Wp" } },
};

function compile(
  npcId,
  text = readFileSync(new URL(`npc/${npcId}.js`, ROOT), "utf8"),
) {
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
  // Cosmic 24-slot rows after the first-job +4; the fifth (cash) is untouched.
  profile.inventorySlots = [28, 28, 28, 28, profile.inventorySlots[4]];
  return { items, travels: [], store: ProfileStore.memory(profile, { items }) };
}

function give(owner, id, count) {
  owner.items[id] ??= { id, descriptor: {}, info: { slotMax: 100 } };
  grantItem(owner.store.profile, owner.items[id], count);
}

function respond(session, action, value) {
  return session.respond({
    sessionId: session.sessionId,
    revision: session.view.revision,
    action,
    ...(value === undefined ? {} : { value }),
  });
}

function talk(owner, npcId, text) {
  const artifact = compile(npcId, text);
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

test("leaving Kyrin's test room removes every carried crystal of both kinds", async () => {
  const owner = character({ job: 500, mapId: "108000502" });
  give(owner, 4031856, 5);
  give(owner, 4031857, 3);
  try {
    const session = talk(owner, 1072008);
    expect((await session.start()).view.kind).toBe("choice");
    expect((await respond(session, "choose", 1)).ok).toBe(true);
    const profile = owner.store.profile;
    expect(itemCount(profile, 4031856)).toBe(0);
    expect(itemCount(profile, 4031857)).toBe(0);
    expect(owner.travels).toEqual([{ mapId: 120000101, portal: 0 }]);
    expect(profile.location.mapId).toBe("120000101");
  } finally {
    await owner.store.destroy();
  }
});

async function advance(session, actions) {
  let result;
  for (const [action, value] of actions) {
    result = await respond(session, action, value);
    expect(result.ok).toBe(true);
  }
  return result;
}

test("custom letter quests 100003/100004 persist through the instructor and test gate", async () => {
  const owner = character();
  try {
    const balrog = talk(owner, 1022000);
    expect((await balrog.start()).ok).toBe(true);
    await advance(balrog, [["next"], ["next"]]);
    let profile = owner.store.profile;
    expect(profile.quests[100003]).toEqual({ state: 1, kills: {} });
    expect(itemCount(profile, 4031008)).toBe(1);
    const saved = JSON.parse(JSON.stringify(profile));
    expect(validateProfile(saved, owner.items)).toEqual(profile);

    const gate = talk(owner, 1072000);
    expect((await gate.start()).view.text).toContain("Dances with Balrog");
    await advance(gate, [["next"], ["next"], ["next"], ["yes"], ["next"]]);
    profile = owner.store.profile;
    expect(profile.quests[100003].state).toBe(2);
    expect(profile.quests[100004]).toEqual({ state: 1, kills: {} });
    expect(itemCount(profile, 4031008)).toBe(0);
    expect(owner.travels).toEqual([{ mapId: 108000300, portal: 0 }]);
  } finally {
    await owner.store.destroy();
  }
});

test("a custom quest record cannot carry mob progress", () => {
  const profile = createProfile({ mapId: "102000003", x: 0, y: 0, facing: 1 });
  profile.quests[100003] = { state: 1, kills: { 100100: 1 } };
  expect(() => validateProfile(profile)).toThrow("quest 100003 kills");
});

const CHANGE = (job) =>
  `function start() { cm.changeJobById(${job}); cm.dispose(); }`;

test("a level-30 warrior becomes a fighter with pool-1 SP, warrior HP and a row per inventory", async () => {
  const owner = character();
  const before = structuredClone(owner.store.profile);
  try {
    expect((await talk(owner, 1022000, CHANGE(110)).start()).ok).toBe(true);
    const profile = owner.store.profile;
    expect(profile.job).toBe(110);
    expect(profile.remainingSp).toEqual([0, 1, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(profile.remainingAp).toBe(before.remainingAp);
    expect(profile.baseMaxHP).toBe(before.baseMaxHP + 300);
    expect(profile.baseMaxMP).toBe(before.baseMaxMP);
    expect(profile.inventorySlots).toEqual(
      before.inventorySlots.map((slots, index) =>
        index < 4 ? slots + 4 : slots,
      ),
    );
  } finally {
    await owner.store.destroy();
  }
});

test("a magician 2nd job gains MP only and every invalid transition is refused", async () => {
  const mage = character({ job: 200 });
  try {
    const before = structuredClone(mage.store.profile);
    expect((await talk(mage, 1032001, CHANGE(230)).start()).ok).toBe(true);
    expect(mage.store.profile.baseMaxMP).toBe(before.baseMaxMP + 450);
    expect(mage.store.profile.baseMaxHP).toBe(before.baseMaxHP);
  } finally {
    await mage.store.destroy();
  }
  for (const [level, job, target] of [
    [29, 100, 110], // below level 30
    [30, 200, 110], // another class's 2nd job
    [30, 0, 110], // beginner skipping 1st job
    [30, 110, 120], // already advanced
    [70, 110, 111], // 3rd job stays unavailable
  ]) {
    const owner = character({ level, job });
    const before = structuredClone(owner.store.profile);
    try {
      const result = await talk(owner, 1022000, CHANGE(target)).start();
      expect(result.ok).toBe(false);
      expect(owner.store.profile).toEqual(before);
    } finally {
      await owner.store.destroy();
    }
  }
});
