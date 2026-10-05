import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { compilePortalScript } from "../../client/tools/portal-script-compiler.js";
import {
  portalRouteStatus,
  scriptedPortalKind,
} from "../../client/src/world/portal-system.js";
import { createProfile } from "../../client/src/profile/profile-validation.js";
import { scriptedPortalTravel } from "../src/field-portal-scripts.js";

const POLICY = JSON.parse(
  readFileSync(
    new URL("../../infra/gameplay-definitions/policy.json", import.meta.url),
    "utf8",
  ),
);

function compile(script) {
  const text = readFileSync(
    new URL(
      `../../infra/gameplay-definitions/portal/${script}.js`,
      import.meta.url,
    ),
    "utf8",
  );
  return compilePortalScript({
    text,
    path: `scripts/portal/${script}.js`,
    sha256: createHash("sha256").update(text).digest("hex"),
    staticConfig: POLICY.staticConfig,
    originalQuestIds: new Set([20718]),
  });
}

// createProfile's starting equipment must resolve against packaged templates.
const ITEMS = {
  1040002: { id: 1040002, descriptor: {}, info: { islot: "Ma" } },
  1060002: { id: 1060002, descriptor: {}, info: { islot: "Pn" } },
  1072001: { id: 1072001, descriptor: {}, info: { islot: "So" } },
  1302000: { id: 1302000, descriptor: {}, info: { islot: "Wp" } },
};

// Original Map.wz portal records (tm/tn/pt/script) for both instructor entrances.
const ENTRANCES = {
  enterMagiclibrar: {
    mapId: 101000000,
    portal: { id: 26, name: "jobin00", type: 7, targetMap: 999999999 },
  },
  enterAchter: {
    mapId: 100000200,
    portal: { id: 9, name: "in02", type: 7, targetMap: 999999999 },
  },
};

function fixture(script, quests = {}) {
  const compilation = compile(script);
  const { mapId, portal } = ENTRANCES[script];
  const profile = createProfile({
    mapId: String(mapId).padStart(9, "0"),
    x: 0,
    y: 0,
    facing: 1,
  });
  profile.quests = quests;
  const field = {
    manifest: {
      physics: { map: { $portalProperties: { [portal.id]: { script } } } },
    },
  };
  const actor = { field, state: "active", profile };
  const failures = [];
  const world = {
    log: (event, detail) => failures.push({ event, ...detail }),
    content: {
      catalog: {
        ui: { items: ITEMS },
        quests: {
          schemaVersion: 1,
          records: { 20718: { id: 20718 } },
          strings: { npc: {}, mob: {}, item: {} },
        },
        mapNames: {
          100000201: "Bowman Instructional School",
          101000003: "Magic Library",
        },
      },
    },
    interactions: {
      workers: 0,
      references: { data: { portalScripts: { [script]: compilation } } },
    },
  };
  return { compilation, world, actor, portal, failures };
}

test("both job-instructor entrances compile as supported portal programs", () => {
  const library = compile("enterMagiclibrar");
  expect(library.blockers).toEqual([]);
  expect(library.status).toBe("supported");
  expect(library.dependencies.mapIds).toEqual([101000003]);
  expect(library.dependencies.questIds).toEqual([20718]);
  const school = compile("enterAchter");
  expect(school.status).toBe("supported");
  expect(school.dependencies.mapIds).toEqual([100000201]);
  for (const [script, { portal }] of Object.entries(ENTRANCES)) {
    expect(scriptedPortalKind(portal, { script })).toBe(script);
  }
});

test("an adventurer enters the Magic Library at portal 8 and revalidates in the transaction", async () => {
  const { world, actor, portal } = fixture("enterMagiclibrar");
  const scripted = await scriptedPortalTravel(world, actor, portal, {
    operationId: "op",
  });
  expect(scripted.destination).toEqual({
    mapId: 101000003,
    portal: 8,
    sound: true,
  });
  expect(
    await scripted.operation.mutate(structuredClone(actor.profile)),
  ).toEqual({});
});

test("the Cygnus quest branch reaches its event-instance trap and fails closed", async () => {
  const { world, actor, portal, failures } = fixture("enterMagiclibrar", {
    20718: { state: 1 },
  });
  const before = structuredClone(actor.profile);
  await expect(
    scriptedPortalTravel(world, actor, portal, { operationId: "op" }),
  ).rejects.toMatchObject({ code: "REQUIREMENTS_NOT_MET" });
  expect(failures.map((failure) => failure.reason)).toEqual([
    "Remote NPC service unavailable: event-instance",
  ]);
  expect(actor.profile).toEqual(before);
});

test("a transaction draft that diverges from the preview rejects the warp", async () => {
  const { world, actor, portal } = fixture("enterMagiclibrar");
  const scripted = await scriptedPortalTravel(world, actor, portal, {
    operationId: "op",
  });
  const draft = structuredClone(actor.profile);
  draft.quests = { 20718: { state: 1 } };
  await expect(scripted.operation.mutate(draft)).rejects.toMatchObject({
    code: "REQUIREMENTS_NOT_MET",
  });
});

test("Athena Pierce's school is entered at its named out02 portal", async () => {
  const { world, actor, portal } = fixture("enterAchter");
  const scripted = await scriptedPortalTravel(world, actor, portal, {
    operationId: "op",
  });
  expect(scripted.destination).toEqual({
    mapId: 100000201,
    portal: "out02",
    sound: true,
  });
});

test("both instructor rooms leave through plain authored portals", () => {
  // 101000003/8 jobout00 -> 101000000/jobin00; 100000201/9 out02 -> 100000200/in02.
  const exits = [
    { id: 8, type: 2, targetMap: 101000000, targetName: "jobin00" },
    { id: 9, type: 2, targetMap: 100000200, targetName: "in02" },
  ];
  for (const exit of exits) {
    expect(scriptedPortalKind(exit, {})).toBeNull();
    expect(portalRouteStatus(exit, {})).toBeNull();
  }
});

test("an uncompiled sentinel script stays unavailable", async () => {
  const { world, actor, portal } = fixture("enterMagiclibrar");
  world.interactions.references.data.portalScripts = {};
  await expect(
    scriptedPortalTravel(world, actor, portal, { operationId: "op" }),
  ).rejects.toMatchObject({ code: "REQUIREMENTS_NOT_MET" });
  expect(actor.admission).toBe(
    "unsupported-content: server-script-unavailable",
  );
});
