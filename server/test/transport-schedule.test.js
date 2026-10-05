import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { compileTransportSchedule } from "../../client/tools/transport-schedule-compiler.js";
import { compileNpcScript } from "../../client/tools/npc-script-compiler.js";
import { NpcScriptSession } from "../../client/src/npc/npc-script-runtime.js";
import { createProfile } from "../../client/src/profile/profile-validation.js";
import { ProfileStore } from "../../client/test/fixtures/memory-profile-store.js";
import { itemCount } from "../../client/src/items/inventory-model.js";
import {
  advanceTransports,
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
  expect(schedule.unsupported).toContain("random-invasion");
  expect(schedule.unsupported).toContain("ship-presentation");
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

function boardingSession(entry) {
  const compilation = compileNpcScript({
    ...source("npc/1032008.js"),
    staticConfig: POLICY.staticConfig,
    originalQuestIds: new Set(),
    eventManagers: new Set(TRANSPORTS),
  });
  expect(compilation.blockers).toEqual([]);
  const items = {
    1040002: { id: 1040002, descriptor: {}, info: { islot: "Ma" } },
    1060002: { id: 1060002, descriptor: {}, info: { islot: "Pn" } },
    1072001: { id: 1072001, descriptor: {}, info: { islot: "So" } },
    1302000: { id: 1302000, descriptor: {}, info: { islot: "Wp" } },
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
