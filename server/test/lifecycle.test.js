import { expect, test } from "bun:test";
import { GameplayGateway } from "../src/gateway.js";
import { OnlineWorld } from "../src/world.js";
import { transitionActor } from "../src/field-transition.js";
import { createProfile } from "../../client/src/profile/profile-validation.js";
import { decodeClient } from "../../shared/protocol.js";

function fixture() {
  const persisted = [];
  const released = [];
  const database = {
    async checkpoint(actor) {
      persisted.push(structuredClone(actor.profile));
    },
    async releaseLease(actor) {
      released.push(actor.id);
    },
  };
  const world = new OnlineWorld({
    content: { items: {} },
    database,
    publish() {},
  });
  const gateway = new GameplayGateway({
    config: {},
    auth: {},
    database,
    world,
  });
  const session = { id: "session", accountId: "account", revoked: false };
  const field = {
    epoch: "source",
    characters: new Map(),
    mobs: [],
    npcs: new Map(),
    drops: new Map(),
    reactors: { records: [] },
    manifest: {},
  };
  const actor = {
    id: "character",
    accountId: session.accountId,
    sessionId: session.id,
    session,
    field,
    state: "active",
    portalUntil: 0,
    pending: false,
    profile: {
      ...createProfile({ mapId: "100000000", x: 0, y: 0, facing: 1 }),
      hp: 100,
      maxHP: 100,
      baseMaxHP: 100,
      mp: 20,
      equipment: [],
    },
    simulation: fixtureSimulation(),
  };
  field.characters.set(actor.id, actor);
  world.actors.set(actor.id, actor);
  gateway.accounts.set(actor.accountId, actor);
  gateway.characters.set(actor.id, actor);
  return { actor, field, gateway, world, session, persisted, released };
}

function fixtureSimulation() {
  return {
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    facing: 1,
    action: "stand1",
    effectiveSettings: { gravityAcc: 2000, gravity: 1, fallSpeed: 670 },
  };
}

test("logout removes combat lookup while peer presence remains until its transition settles", async () => {
  const probe = fixture();
  expect(probe.world.nearby(probe.actor, probe.actor.id, "player", 100)).toBe(
    probe.actor,
  );
  const destination = Promise.withResolvers();
  probe.world.fieldFor = () => destination.promise;
  probe.actor.pending = true;
  const transfer = transitionActor(
    probe.world,
    probe.actor,
    { mapId: 100000001 },
    {},
  );
  const settled = transfer
    .catch((error) => error.code)
    .finally(() => {
      probe.actor.pending = false;
      probe.world.participants.signalIdle();
    });
  probe.session.revoked = true;
  const logout = probe.gateway.logout(probe.session);
  expect(probe.world.entities(probe.actor).map((entity) => entity.id)).toEqual([
    probe.actor.id,
  ]);
  expect(() =>
    probe.world.nearby(probe.actor, probe.actor.id, "player", 100),
  ).toThrow("NOT_FOUND");
  expect(probe.released).toEqual([]);
  destination.resolve({ characters: new Map() });
  expect(await settled).toBe("SESSION_EXPIRED");
  await logout;
  expect(probe.actor.state).toBe("retired");
  expect(probe.field.characters.has(probe.actor.id)).toBe(false);
  expect(probe.gateway.accounts.has(probe.actor.accountId)).toBe(false);
  expect(probe.persisted[0].hp).toBe(100);
  expect(probe.released).toEqual([probe.actor.id]);
});

test("transfer drains only its known old field and baselines before destination ready", () => {
  const { gateway, actor, world } = fixture();
  // This admission fixture has no database/native presentation. Observe readiness
  // publication without running unrelated social/profile preparation.
  world.participants.publish = async () => {};
  actor.field.epoch = "destination";
  const data = {
    actor,
    ready: false,
    baselines: new Map([["new", 8]]),
    transfer: { sourceEpoch: "source", baselines: new Map([["old", 4]]) },
  };
  actor.eventSeq = 8;
  expect(
    gateway.admitField(data, { type: "input", fieldEpoch: "source" }),
  ).toBe(false);
  expect(
    gateway.admitField(
      data,
      decodeClient(
        JSON.stringify({
          v: 1,
          type: "ack",
          connectionEpoch: "connection",
          seq: 1,
          snapshotId: "old",
          eventSeq: 4,
        }),
      ),
    ),
  ).toBe(false);
  expect(
    gateway.drainsTransfer(data, {
      type: "ack",
      snapshotId: "new",
      eventSeq: 8,
    }),
  ).toBe(false);
  for (const eventSeq of [3, 9]) {
    expect(
      gateway.drainsTransfer(data, {
        type: "ack",
        snapshotId: "old",
        eventSeq,
      }),
    ).toBe(false);
  }
  expect(() =>
    gateway.admitField(data, {
      type: "ack",
      fieldEpoch: "source",
      snapshotId: "invented",
      eventSeq: 4,
    }),
  ).toThrow();
  gateway.ready({ data }, { snapshotId: "new" });
  expect(() =>
    gateway.admitField(data, { type: "input", fieldEpoch: "source" }),
  ).toThrow();
});

test("transient socket close retains authoritative presence for reconnect", () => {
  const { gateway, actor, world } = fixture();
  const socket = { data: { actor } };
  actor.connection = socket;
  gateway.closed(socket);
  expect(world.actors.get(actor.id)).toBe(actor);
  expect(actor.field.characters.get(actor.id)).toBe(actor);
  expect(actor.disconnectedAt).toBeGreaterThan(0);
});

test("dead logout checkpoints authored return-map arrival and restored HP before releasing", async () => {
  const probe = fixture();
  probe.actor.profile.hp = 0;
  probe.actor.profile.maxHP = 100;
  probe.field.manifest = {
    id: "100000000",
    physics: { map: { returnMap: 101000000 } },
  };
  probe.world.content.map = async () => ({
    id: "101000000",
    physics: { portals: [{ id: 0, x: 125, y: 300 }] },
  });
  probe.session.revoked = true;
  await probe.gateway.logout(probe.session);
  expect(probe.persisted[0].hp).toBe(50);
  expect(probe.persisted[0].location).toEqual({
    mapId: "101000000",
    x: 125,
    y: 290,
    facing: 1,
  });
  expect(probe.released).toEqual([probe.actor.id]);
});

test("a checkpoint failure retires only its lease holder and the shared field remains reusable", async () => {
  const f = fixture();
  const error = Object.assign(new Error("temporary persistence failure"), {
    code: "SERVER_BUSY",
  });
  const save = f.world.database.checkpoint;
  let attempts = 0;
  f.world.database.checkpoint = async (actor) => {
    if (++attempts === 1) throw error;
    return save(actor);
  };
  f.world.now = 10000;
  f.actor.lastCheckpoint = 0;
  f.actor.runtimeDirty = true;
  f.actor.disconnectedAt = null;
  f.actor.leaseRenewAt = 10000;
  const peer = { ...f.actor, id: "peer", accountId: "peer-account" };
  f.field.characters.set(peer.id, peer);
  f.world.fields.set("public:100000000", f.field);
  f.world.checkpoint(f.actor);
  await f.world.participants.waitIdle(f.actor);
  expect(f.actor.deliveryError).toBe(error);
  expect(f.actor.runtimeDirty).toBe(true);
  expect(f.field.fault).toBeUndefined();
  expect(peer.deliveryError).toBeUndefined();
  f.gateway.auth.active = () => true;
  f.gateway.maintainActor(f.actor, 10000);
  await f.actor.retirement;
  expect(attempts).toBe(2);
  expect(f.released).toEqual([f.actor.id]);
  expect(f.field.characters.has(peer.id)).toBe(true);
  expect(await f.world.fieldFor(100000000)).toBe(f.field);
  let ticks = 0;
  f.world.tickField = () => {
    ticks++;
  };
  f.world.debt = 0;
  f.field.paused = false;
  f.world.step(1000);
  f.world.step(1030);
  expect(ticks).toBe(1);
});

test("a watchdog kick completes retirement and releases the character instead of leaving it busy", async () => {
  const probe = fixture();
  const { actor, gateway, world } = probe;
  gateway.auth.active = () => true;
  actor.disconnectedAt = null;
  actor.leaseRenewAt = 10000;
  const pending = Promise.withResolvers();
  const checkpoint = gateway.database.checkpoint;
  gateway.database.checkpoint = async (current) => {
    await pending.promise;
    await checkpoint(current);
  };
  world.faultMotion(actor, { position: 200, velocity: 0, elapsedMs: 30 });
  expect(actor.retiring).toBe(true);
  gateway.maintainActor(actor, 10000);
  expect(actor.retirement).toBeInstanceOf(Promise);
  const retirement = actor.retirement;
  gateway.maintainActor(actor, 10001);
  expect(actor.retirement).toBe(retirement);
  expect(probe.released).toEqual([]);
  pending.resolve();
  await retirement;
  expect(probe.persisted).toHaveLength(1);
  expect(probe.released).toEqual([actor.id]);
  expect(gateway.accounts.has(actor.accountId)).toBe(false);
  expect(gateway.characters.has(actor.id)).toBe(false);
  expect(world.actors.has(actor.id)).toBe(false);
  expect(probe.field.characters.has(actor.id)).toBe(false);
});
