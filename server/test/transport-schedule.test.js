import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { compileTransportSchedule } from "../../client/tools/transport-schedule-compiler.js";
import { compileNpcScript } from "../../client/tools/npc-script-compiler.js";
import { NpcScriptSession } from "../../client/src/npc/npc-script-runtime.js";
import { createProfile } from "../../client/src/profile/profile-validation.js";
import { ProfileStore } from "../../client/test/fixtures/memory-profile-store.js";
import { itemCount } from "../../client/src/items/inventory-model.js";
import { createSimulation } from "../../client/src/physics/simulation.js";
import {
  advanceTransports,
  invasionRoll,
  transportProperties,
  transportState,
  transportTimes,
} from "../src/transport-schedule.js";

const ROOT = new URL("../../infra/gameplay-definitions/", import.meta.url);
const POLICY = JSON.parse(readFileSync(new URL("policy.json", ROOT), "utf8"));
const TRANSPORTS = ["AirPlane", "Boats", "Cabin", "Genie", "Subway", "Trains"];

function source(path) {
  const text = readFileSync(new URL(path, ROOT), "utf8");
  return {
    text,
    path: `scripts/${path}`,
    sha256: createHash("sha256").update(text).digest("hex"),
  };
}

function boats(travelRate = 5) {
  return {
    ...compileTransportSchedule(source("event/Boats.js")),
    travelRate,
  };
}

test("exactly the six canonical transport cycles compile from vendored events", () => {
  const supported = readdirSync(new URL("event/", ROOT))
    .filter(
      (file) =>
        compileTransportSchedule(source(`event/${file}`)).status ===
        "supported",
    )
    .map((file) => file.slice(0, -3))
    .sort();
  expect(supported).toEqual(TRANSPORTS);
  expect(compileTransportSchedule(source("event/Elevator.js")).status).toBe(
    "blocked",
  );
});

test("Boats.js keeps its authored times, maps and unsupported members", () => {
  const schedule = boats();
  expect(schedule.closeTime).toEqual({ ms: 240000, scaled: true });
  expect(schedule.beginTime).toEqual({ ms: 300000, scaled: true });
  expect(schedule.rideTime).toEqual({ ms: 600000, scaled: true });
  expect(schedule.departures).toContainEqual({
    from: 101000301,
    to: 200090010,
    randomSpawn: true,
  });
  expect(schedule.arrivals).toContainEqual({
    from: 200090010,
    to: 200000100,
    portal: 0,
  });
  expect(schedule.arrivals).toContainEqual({
    from: 200090000,
    to: 101000300,
    portal: 1,
  });
  expect(schedule.unsupported).toEqual([
    "field-object-clearing",
    "music-change",
    "ship-presentation",
  ]);
});

test("Boats.js publishes its authored Crimson Balrog invasion", () => {
  const deck = (mapId, x, y) => ({ mapId, mobId: 8150000, x, y });
  expect(boats().invasion).toEqual({
    chance: 0.42,
    approachChance: 1,
    approachTime: { ms: 180000, scaled: true },
    approachJitter: { ms: 60000, scaled: true },
    spawnDelay: { ms: 5000, scaled: false },
    spawns: [
      deck(200090000, -538, 143),
      deck(200090000, -538, 143),
      deck(200090010, 339, 148),
      deck(200090010, 339, 148),
    ],
  });
  for (const event of ["Trains", "Subway", "Cabin", "Genie", "AirPlane"]) {
    expect(
      compileTransportSchedule(source(`event/${event}.js`)).invasion,
    ).toBeUndefined();
  }
});

/** Departures of the default-rate cycle (period 180 s, takeoff 60 s in). */
const takeoffOf = (index) => index * 180000 + 60000;

test("the invasion roll uses the authored chance and is stable per departure", () => {
  const schedule = boats();
  let invaded = 0;
  for (let index = 0; index < 4000; index++) {
    const roll = invasionRoll(schedule, takeoffOf(index));
    expect(invasionRoll(schedule, takeoffOf(index))).toEqual(roll);
    if (!roll) continue;
    invaded++;
    // 36 s + trunc(random * 12 s) + unscaled 5 s after takeoff, before arrival.
    const after = roll.spawnAt - takeoffOf(index);
    expect(after).toBeGreaterThanOrEqual(41000);
    expect(after).toBeLessThan(53000);
  }
  expect(invaded / 4000).toBeGreaterThan(0.39);
  expect(invaded / 4000).toBeLessThan(0.45);
  // Travel rate 1 keeps the authored 3 min + up to 1 min, plus 5 s.
  const index = [...Array(100).keys()].find((k) =>
    invasionRoll(boats(1), k * 900000 + 300000),
  );
  const after =
    invasionRoll(boats(1), index * 900000 + 300000).spawnAt -
    (index * 900000 + 300000);
  expect(after).toBeGreaterThanOrEqual(185000);
  expect(after).toBeLessThan(245000);
});

test("travelRate scales the cycle like getTransportationTime; rate 1 is v83", () => {
  expect(transportTimes(boats(1))).toEqual({
    close: 240000,
    begin: 300000,
    ride: 600000,
    period: 900000,
  });
  expect(POLICY.travelRate).toBe(1);
  expect(transportTimes(boats())).toEqual({
    close: 48000,
    begin: 60000,
    ride: 120000,
    period: 180000,
  });
  const schedule = boats();
  const start = 180000 * 1000;
  expect(transportState(schedule, start)).toEqual({
    docked: true,
    entry: true,
    nextDeparture: start + 60000,
  });
  expect(transportState(schedule, start + 48000)).toMatchObject({
    docked: true,
    entry: false,
  });
  expect(transportState(schedule, start + 60000)).toMatchObject({
    docked: false,
    entry: false,
    nextDeparture: start + 240000,
  });
  expect(transportState(schedule, start + 180000)).toMatchObject({
    docked: true,
    entry: true,
  });
});

const BASE_ITEMS = {
  1040002: { id: 1040002, descriptor: {}, info: { islot: "Ma" } },
  1060002: { id: 1060002, descriptor: {}, info: { islot: "Pn" } },
  1072001: { id: 1072001, descriptor: {}, info: { islot: "So" } },
  1302000: { id: 1302000, descriptor: {}, info: { islot: "Wp" } },
};

function boardingSession(entry) {
  const compilation = compileNpcScript({
    ...source("npc/1032008.js"),
    staticConfig: POLICY.staticConfig,
    originalQuestIds: new Set(),
    eventManagers: new Set(TRANSPORTS),
  });
  expect(compilation.blockers).toEqual([]);
  const items = {
    ...BASE_ITEMS,
    4031045: { id: 4031045, descriptor: {}, info: { slotMax: 100 } },
  };
  const profile = createProfile({ mapId: "101000300", x: 0, y: 0, facing: 1 });
  profile.inventory.push({
    uid: "orbis-ticket",
    id: 4031045,
    count: 1,
    slot: 1,
    owner: "",
    flags: 0,
    expiresAt: null,
  });
  const store = ProfileStore.memory(profile, { items });
  const travels = [];
  const environment = {
    npcId: 1032008,
    items,
    quests: { schemaVersion: 1, records: {} },
    names: { npc: { 1032008: "Rini" }, item: { 4031045: "Ticket" }, mob: {} },
    mapNames: { 101000301: "Before Takeoff <To Orbis>" },
    portraits: { 1032008: {} },
    shops: {},
    artwork: new Set(),
    artworkMetadata: {},
    events: { Boats: { docked: String(entry), entry: String(entry) } },
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
  return {
    store,
    travels,
    session: new NpcScriptSession(compilation, store, environment),
  };
}

function respond(session, action) {
  return session.respond({
    sessionId: session.sessionId,
    revision: session.view.revision,
    action,
  });
}

test("Rini boards a ticket holder only while Boats entry is open", async () => {
  const open = boardingSession(true);
  try {
    expect(itemCount(open.store.profile, 4031045)).toBe(1);
    expect((await open.session.start()).view.kind).toBe("yes-no");
    expect((await respond(open.session, "yes")).ok).toBe(true);
    expect(open.travels).toEqual([{ mapId: 101000301, randomSpawn: true }]);
    expect(open.store.profile.location.mapId).toBe("101000301");
    expect(itemCount(open.store.profile, 4031045)).toBe(0);
  } finally {
    await open.store.destroy();
  }
  const closed = boardingSession(false);
  try {
    const view = (await closed.session.start()).view;
    expect(view.kind).toBe("say");
    expect(view.text).toContain("already travelling");
    expect(itemCount(closed.store.profile, 4031045)).toBe(1);
  } finally {
    await closed.store.destroy();
  }
});

const settle = () =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

function transportWorld(now) {
  const moves = [];
  const actor = {
    id: "a",
    revision: 1,
    state: "active",
    field: { mapId: 101000301, epoch: "e0" },
  };
  const world = {
    now,
    actors: new Map([[actor.id, actor]]),
    fields: new Map(),
    invalidateField: () => {},
    participants: { busy: () => false, signalIdle: () => {} },
    interactions: {
      references: { data: { transportSchedules: { Boats: boats() } } },
    },
    async transition(target, destination, operation) {
      expect(operation.kind).toBe("transport.travel");
      moves.push({ at: world.now, ...destination });
      target.field = { mapId: destination.mapId, epoch: `e${moves.length}` };
      return { status: "committed" };
    },
  };
  return { world, actor, moves };
}

test("a boarded passenger departs at the scaled takeoff and arrives in Orbis", async () => {
  const start = 180000 * 1000;
  const { world, actor, moves } = transportWorld(start + 1000);
  advanceTransports(world);
  await settle();
  await settle();
  expect(transportProperties(world).Boats).toEqual({
    docked: "true",
    entry: "true",
  });
  advanceTransports(world);
  expect(moves).toEqual([]);
  world.now = start + 60000; // takeoff: ride time scaled 5x
  advanceTransports(world);
  await settle();
  expect(moves).toEqual([
    { at: start + 60000, mapId: 200090010, randomSpawn: true },
  ]);
  await settle();
  world.now = start + 179999;
  advanceTransports(world);
  expect(moves.length).toBe(1);
  world.now = start + 180000; // arrived
  advanceTransports(world);
  await settle();
  expect(moves[1]).toEqual({ at: start + 180000, mapId: 200000100, portal: 0 });
  expect(actor.field.mapId).toBe(200000100);
});

/** A one-floor ride field carrying a Crimson Balrog template (y 200 under every spawn). */
function rideField(mapId) {
  const physics = {
    schemaVersion: 1,
    // Positive placeholders: the stationary fixture mob never reads them.
    globals: Object.fromEntries(
      "walkForce walkSpeed walkDrag slipForce slipSpeed floatDrag1 floatDrag2 floatCoefficient swimForce swimSpeed flyForce flySpeed gravityAcc fallSpeed jumpSpeed maxFriction minFriction swimSpeedDec flyJumpDec"
        .split(" ")
        .map((key) => [key, 1]),
    ),
    map: {},
    footholds: [
      { id: 1, layer: 1, group: 0, x1: -800, y1: 200, x2: 800, y2: 200 },
    ].map((row) => ({ ...row, prev: 0, next: 0, properties: {} })),
    ladders: [],
  };
  const stand = {
    timingKnown: true,
    frames: [
      { delayMs: 180, body: { left: -4, top: -8, right: 6, bottom: 0 } },
    ],
  };
  const template = {
    kind: "mob",
    originalId: "8150000",
    defaultAction: "stand",
    info: { maxHP: 1000, speed: 0 },
    actions: { stand },
  };
  return {
    mapId,
    physics,
    geometry: createSimulation(physics, { x: 0, y: 200 }).geometry,
    manifest: { life: { templates: { "mob:8150000": template } } },
    mobs: [],
    npcs: new Map(),
    characters: new Map(),
  };
}

function invasionWorld(invaded) {
  const index = [...Array(100).keys()].find(
    (k) => Boolean(invasionRoll(boats(), takeoffOf(k))) === invaded,
  );
  const takeoff = takeoffOf(index);
  const { world, actor, moves } = transportWorld(takeoff - 60000);
  const fields = [200090000, 200090010, 200090011].map(rideField);
  for (const field of fields) world.fields.set(`public:${field.mapId}`, field);
  const [ellinia, orbis, cabin] = fields;
  return { world, actor, moves, takeoff, ellinia, orbis, cabin };
}

const invaders = (field) => field.mobs.filter((mob) => mob.invasion);

test("an invaded ride spawns the authored Balrogs on the decks only; arrival removes them", async () => {
  const { world, actor, moves, takeoff, ellinia, orbis, cabin } =
    invasionWorld(true);
  advanceTransports(world);
  await settle();
  await settle();
  // A passenger rests in the Orbis-bound cabin, reached by the deck's in00 portal.
  actor.field = { mapId: 200090011, epoch: "cabin" };
  const { spawnAt } = invasionRoll(boats(), takeoff);
  world.now = spawnAt - 1;
  advanceTransports(world);
  expect(invaders(orbis)).toEqual([]);
  world.now = spawnAt;
  advanceTransports(world);
  for (const [field, x] of [
    [ellinia, -538],
    [orbis, 339],
  ]) {
    expect(
      invaders(field).map((mob) => [mob.templateId, mob.x, mob.y]),
    ).toEqual([
      [8150000, x, 200],
      [8150000, x, 200],
    ]);
  }
  expect(cabin.mobs).toEqual([]);
  expect(moves).toEqual([]);
  // Level-triggered: later ticks keep the same two monsters.
  const spawned = invaders(orbis);
  world.now = spawnAt + 1000;
  advanceTransports(world);
  expect(invaders(orbis)).toEqual(spawned);
  world.now = takeoff + 120000; // arrived: killAllMonsters + cabin warpEveryone
  advanceTransports(world);
  await settle();
  expect(invaders(ellinia)).toEqual([]);
  expect(invaders(orbis)).toEqual([]);
  expect(moves).toEqual([
    { at: takeoff + 120000, mapId: 200000100, portal: 0 },
  ]);
  expect(actor.field.mapId).toBe(200000100);
});

test("a ride whose invasion roll fails spawns nothing", async () => {
  const { world, takeoff, ellinia, orbis } = invasionWorld(false);
  advanceTransports(world);
  await settle();
  for (let at = takeoff; at < takeoff + 120000; at += 1000) {
    world.now = at;
    advanceTransports(world);
    expect([...ellinia.mobs, ...orbis.mobs]).toEqual([]);
  }
});

function compileSource(text) {
  return compileNpcScript({
    text,
    path: "scripts/npc/test.js",
    sha256: createHash("sha256").update(text).digest("hex"),
    staticConfig: POLICY.staticConfig,
    originalQuestIds: new Set(),
  });
}

test("a selection-indexed warp closes over its offered choices and fails closed otherwise", () => {
  const menu = (warp) =>
    `function start() { cm.sendSimple("#L0#a#l\\r\\n#L1#b#l"); }\n` +
    `function action(mode, type, selection) { ${warp} cm.dispose(); }`;
  // -1 is the selection every non-choice response carries.
  expect(
    compileSource(menu("cm.warp(100000000 + selection * 100);")).dependencies
      .mapIds,
  ).toEqual([99999900, 100000000, 100000100]);
  for (const warp of [
    "var n = selection; n++; cm.warp(100000000 + n);",
    "cm.warp(100000000 + cm.getMeso());",
  ]) {
    expect(
      compileSource(menu(warp)).blockers.map((row) => row.reason),
    ).toContain("mapIds must have a complete finite literal dependency set");
  }
});

test("Isa sends an Orbis arrival to the chosen platform", async () => {
  const compilation = compileNpcScript({
    ...source("npc/2012006.js"),
    staticConfig: POLICY.staticConfig,
    originalQuestIds: new Set(),
  });
  expect(compilation.blockers).toEqual([]);
  // Platforms 200000110..200000160 are Map.wz Orbis station platforms.
  expect(compilation.dependencies.mapIds).toEqual([
    200000100, 200000110, 200000120, 200000130, 200000140, 200000150, 200000160,
  ]);
  const profile = createProfile({ mapId: "200000100", x: 0, y: 0, facing: 1 });
  const store = ProfileStore.memory(profile, { items: BASE_ITEMS });
  const travels = [];
  const environment = {
    npcId: 2012006,
    items: BASE_ITEMS,
    quests: { schemaVersion: 1, records: {} },
    names: { npc: { 2012006: "Isa" }, item: {}, mob: {} },
    mapNames: Object.fromEntries(
      compilation.dependencies.mapIds.map((id) => [id, `Map ${id}`]),
    ),
    portraits: { 2012006: {} },
    shops: {},
    artwork: new Set(),
    artworkMetadata: {},
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
  const session = new NpcScriptSession(compilation, store, environment);
  try {
    const menu = (await session.start()).view;
    expect(menu.choices.map((choice) => choice.id)).toEqual([0, 1, 2, 3, 4, 5]);
    await session.respond({
      sessionId: session.sessionId,
      revision: session.view.revision,
      action: "choose",
      value: 0,
    });
    expect((await respond(session, "next")).ok).toBe(true);
    expect(travels).toEqual([{ mapId: 200000110, portal: "west00" }]);
  } finally {
    await store.destroy();
  }
});
