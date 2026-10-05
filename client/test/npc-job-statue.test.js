import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { compileNpcScript } from "../tools/npc-script-compiler.js";
import { NpcScriptSession } from "../src/npc/npc-script-runtime.js";
import { createProfile } from "../src/profile/profile-validation.js";
import { ProfileStore } from "./fixtures/memory-profile-store.js";

const CONFIG = {
  USE_AUTOASSIGN_STARTERS_AP: true,
  USE_STARTING_AP_4: false,
  USE_ENFORCE_JOB_SP_RANGE: false,
};
const ITEMS = {
  1040002: { id: 1040002, descriptor: {}, info: { islot: "Ma" } },
  1060002: { id: 1060002, descriptor: {}, info: { islot: "Pn" } },
  1072001: { id: 1072001, descriptor: {}, info: { islot: "So" } },
  1302000: { id: 1302000, descriptor: {}, info: { islot: "Wp" } },
};
const PATH = "scripts/npc/9201127.js";
const TEXT = readFileSync(
  new URL("../../infra/gameplay-definitions/npc/9201127.js", import.meta.url),
  "utf8",
);

function compile(text) {
  return compileNpcScript({
    text,
    path: PATH,
    sha256: "0".repeat(64),
    staticConfig: CONFIG,
    originalQuestIds: new Set(),
  });
}

async function start(level, job) {
  const artifact = compile(TEXT);
  expect(artifact.blockers).toEqual([]);
  const profile = createProfile({ mapId: "104000000", x: 0, y: 0, facing: 1 });
  profile.level = level;
  profile.job = job;
  const store = ProfileStore.memory(profile, { items: ITEMS });
  const environment = {
    npcId: 9201127,
    items: ITEMS,
    quests: { schemaVersion: 1, records: {} },
    names: { npc: { 9201127: "Pirate Statue" }, item: {}, mob: {} },
    mapNames: { 120000101: "Navigation Room" },
    portraits: { 9201127: {} },
    shops: {},
    artwork: new Set(),
    artworkMetadata: {},
    isCurrent: () => true,
    isBusy: () => false,
    prepareTravel: async () => {
      throw new Error("Unexpected travel");
    },
  };
  const session = new NpcScriptSession(artifact, store, environment);
  try {
    const result = await session.start();
    expect(result.ok).toBe(true);
    return result.view;
  } finally {
    await store.destroy();
  }
}

test('Pirate Statue lowers getJob() == "BEGINNER" to the beginner job ID', async () => {
  expect((await start(10, 0)).kind).toBe("yes-no");
  expect(JSON.stringify(await start(9, 0))).toContain("train yourself further");
  expect(JSON.stringify(await start(30, 500))).toContain("Keep training");
});

test("an unknown job enum name in either operand order blocks compilation", () => {
  for (const test of ['cm.getJob() != "PIRATE"', '"PIRATE" == cm.getJob()']) {
    const artifact = compile(
      `function start() { if (${test}) cm.sendOk("a"); cm.dispose(); }`,
    );
    expect(artifact.blockers.map((row) => row.reason)).toEqual([
      "Unsupported job enum name: PIRATE",
    ]);
  }
});
