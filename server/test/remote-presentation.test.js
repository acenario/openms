import { recordPeerMove, collectPeerMoves } from "../src/peer-move-stream.js";
import { RemotePlayerPath } from "../../client/src/online/remote-player-path.js";
import { expect, test } from "bun:test";
import { actorEntity, peerMotionEntity } from "../src/field-views.js";
import { OnlineWorld } from "../src/world.js";
import { createProfile } from "../../client/src/profile/profile-validation.js";
import { decodeServer, PROTOCOL } from "../../shared/protocol.js";

function message(entity) {
  return {
    v: 1,
    type: "state",
    connectionEpoch: "connection",
    serverTick: 1,
    snapshotId: "snapshot",
    baseSnapshotId: "baseline",
    fieldEpoch: "field",
    eventSeq: 1,
    ackInputSeq: null,
    changes: [{ kind: "upsert", entity }],
  };
}

test("peer projection publishes detached effective gravity and ladder limits in a compact validated view", () => {
  const profile = createProfile({ mapId: "000050000", x: 0, y: 0, facing: 1 });
  const sim = {
    x: 20,
    y: 30,
    vx: 0,
    vy: -100,
    facing: 1,
    action: "ladder",
    state: "ladder",
    effectiveSettings: { gravityAcc: 2000, gravity: 0.5, fallSpeed: 600 },
    ignoredFootholdId: 2,
    contactLayer: 1,
    contactGroup: 0,
    ladder: { x: 20, y1: 0, y2: 90 },
  };
  const view = actorEntity({
    id: "player",
    profile,
    simulation: sim,
    actionStartTick: 1,
  });
  const projection = decodeServer(JSON.stringify(message(view))).changes[0]
    .entity.playerMotion;
  expect(projection).toEqual({
    pathTick: 0,
    state: "ladder",
    gravity: 1000,
    fallSpeed: 300,
    ignoredFoothold: 2,
    contactLayer: 1,
    contactGroup: 0,
    ladder: { x: 20, top: 0, bottom: 90 },
  });
  expect(JSON.stringify(projection).length).toBeLessThan(200);
  sim.ladder.x = 999;
  expect(view.playerMotion.ladder.x).toBe(20);
  view.playerMotion.gravity = -1;
  expect(() => decodeServer(JSON.stringify(message(view)))).toThrow(
    "INVALID_MESSAGE",
  );
  view.playerMotion.gravity = 1000;
  view.kind = "mob";
  view.appearance = null;
  expect(() => decodeServer(JSON.stringify(message(view)))).toThrow(
    "INVALID_MESSAGE",
  );
});

test("the un-acked peer move stream validates and carries only sampled motion", () => {
  const profile = createProfile({ mapId: "000050000", x: 0, y: 0, facing: 1 });
  const sim = {
    x: 20,
    y: 30,
    vx: 125,
    vy: -100,
    facing: -1,
    action: "jump",
    state: "air",
    effectiveSettings: { gravityAcc: 2000, gravity: 1, fallSpeed: 670 },
    ignoredFootholdId: 0,
    contactLayer: 7,
    contactGroup: 0,
    ladder: null,
  };
  const entry = peerMotionEntity({
    id: "peer",
    profile,
    simulation: sim,
    actionStartTick: 7,
  });
  Object.assign(entry, { tick: 4, durationMs: 30, moveType: 0 });
  const frame = {
    v: 1,
    type: "peers",
    connectionEpoch: "connection",
    serverTick: 4,
    fieldEpoch: "field",
    tick: 4,
    entries: [entry],
  };
  const decoded = decodeServer(JSON.stringify(frame));
  expect(decoded.entries[0].position).toEqual({ x: 20, y: 30 });
  expect(decoded.entries[0].velocity).toEqual({ x: 125, y: -100 });
  expect(decoded.entries[0].actionStartTick).toBe(7);
  expect(decoded.entries[0].playerMotion.state).toBe("air");
  // No appearance, inventory or input may ride the un-acked stream.
  expect(decoded.entries[0].appearance).toBeUndefined();
  expect(decoded.entries[0].playerMotion.held).toBeUndefined();
  expect(JSON.stringify(entry).length).toBeLessThan(400);
  // Bounded entry count is enforced by the wire schema, not by hope.
  const oversized = {
    ...frame,
    entries: new Array(PROTOCOL.MAX_PEER_MOTIONS + 1).fill(entry),
  };
  expect(() => decodeServer(JSON.stringify(oversized))).toThrow(
    "INVALID_MESSAGE",
  );
});

function movingActor(id, x) {
  return {
    id,
    state: "active",
    retiring: false,
    deliveryError: null,
    actionStartTick: 1,
    skillField: null,
    profile: { hp: 50 },
    simulation: {
      x,
      y: 0,
      vx: 125,
      vy: 0,
      facing: 1,
      action: "walk1",
      state: "ground",
      foothold: { id: 1 },
      ignoredFootholdId: 0,
      contactLayer: 1,
      contactGroup: 0,
      ladder: null,
      effectiveSettings: { gravityAcc: 2000, gravity: 1, fallSpeed: 670 },
    },
  };
}

function peerField(actors, tick = 4) {
  return {
    epoch: "field",
    tick,
    characters: new Map(actors.map((a) => [a.id, a])),
  };
}

test("the un-acked move stream publishes each changed peer once per tick and never for itself", () => {
  const a = movingActor("a", 0),
    b = movingActor("b", 10);
  const sent = [];
  const host = Object.create(OnlineWorld.prototype);
  host.publish = (actor, record) => sent.push({ to: actor.id, record });
  host.publishPeerMotions(peerField([a, b]));
  expect(sent.length).toBe(2);
  for (const entry of sent) expect(entry.record.type).toBe("peers");
  expect(
    sent.find((entry) => entry.to === "a").record.entries.map((e) => e.id),
  ).toEqual(["b"]);
  expect(
    sent.find((entry) => entry.to === "b").record.entries.map((e) => e.id),
  ).toEqual(["a"]);
  // An unchanged field publishes nothing.
  sent.length = 0;
  host.publishPeerMotions(peerField([a, b], 5));
  expect(sent.length).toBe(0);
  // Only the mover crosses the wire, and only to the other actor.
  b.simulation.x = 20;
  sent.length = 0;
  host.publishPeerMotions(peerField([a, b], 6));
  expect(sent.length).toBe(1);
  expect(sent[0].to).toBe("a");
  expect(sent[0].record.entries.map((e) => e.id)).toEqual(["b"]);
});

test("a crowded field bounds the move stream without starving an actor forever", () => {
  const actors = Array.from({ length: 30 }, (_, index) =>
    movingActor(`p${index}`, index),
  );
  const sent = [];
  const host = Object.create(OnlineWorld.prototype);
  host.publish = (actor, record) => sent.push({ to: actor.id, record });
  const field = peerField(actors);
  const seen = new Set();
  for (let tick = 1; tick <= 30; tick++) {
    field.tick = tick;
    for (const actor of actors) actor.simulation.x += 1;
    sent.length = 0;
    host.publishPeerMotions(field);
    for (const entry of sent) {
      expect(entry.record.entries.length).toBeLessThanOrEqual(
        PROTOCOL.MAX_PEER_MOTIONS,
      );
      for (const item of entry.record.entries) seen.add(item.id);
    }
  }
  // Rotation across the bounded sample window reaches every actor.
  expect(seen.size).toBe(30);
});

test("crowded publication retains intermediate samples in source tick order", () => {
  const actors = Array.from({ length: 30 }, (_, i) => movingActor(`p${i}`, 0));
  const host = Object.create(OnlineWorld.prototype);
  const field = peerField(actors);
  const traces = new Map(actors.map((actor) => [actor.id, []]));
  // Inspect only the recipient p0, plus p1 for p0's path; no duplicate recipients.
  host.publish = (actor, record) => {
    for (const sample of record.entries) {
      if (actor.id !== (sample.id === "p0" ? "p1" : "p0")) continue;
      traces.get(sample.id).push(sample);
    }
  };
  for (let tick = 1; tick <= 100; tick++) {
    field.tick = tick;
    if (tick <= 20) for (const actor of actors) actor.simulation.x = tick * 3;
    host.publishPeerMotions(field);
  }
  for (const trace of traces.values()) {
    expect(trace.map((e) => e.tick)).toEqual(
      Array.from({ length: 20 }, (_, i) => i + 1),
    );
    expect(trace.map((e) => e.position.x)).toEqual(
      Array.from({ length: 20 }, (_, i) => (i + 1) * 3),
    );
    expect(trace.every((e) => e.durationMs === 30 && e.moveType === 0)).toBe(
      true,
    );
  }
});

test("teleports discard queued pre-relocation movement and field replacement resets ownership", () => {
  const a = movingActor("a", 0),
    b = movingActor("b", 10);
  const sent = [];
  const host = Object.create(OnlineWorld.prototype);
  host.publish = (actor, record) => sent.push({ id: actor.id, record });
  const field = peerField([a, b]);
  host.publishPeerMotions(field);
  a.simulation.x = 5;
  a.simulation.relocationSequence = 1;
  field.tick++;
  sent.length = 0;
  host.publishPeerMotions(field);
  expect(sent[0].record.entries[0]).toMatchObject({
    id: "a",
    tick: 5,
    durationMs: 0,
    moveType: 3,
    position: { x: 5, y: 0 },
  });
  field.epoch = "other";
  field.tick = 1;
  sent.length = 0;
  host.publishPeerMotions(field);
  expect(sent).toHaveLength(2);
  expect(sent[0].record.entries[0].moveType).toBe(0);
});

test("path duration and discontinuity fields reject malformed wire values", () => {
  const host = Object.create(OnlineWorld.prototype);
  let frame;
  host.publish = (_actor, record) => {
    frame = {
      v: 1,
      connectionEpoch: "connection",
      serverTick: 4,
      ...record,
    };
  };
  host.publishPeerMotions(
    peerField([movingActor("a", 0), movingActor("b", 10)]),
  );
  expect(decodeServer(JSON.stringify(frame)).entries[0].durationMs).toBe(30);
  for (const value of [-1, 32768, 1.5]) {
    frame.entries[0].durationMs = value;
    const encoded = JSON.stringify(frame);
    expect(() => decodeServer(encoded)).toThrow("INVALID_MESSAGE");
  }
  frame.entries[0].durationMs = 30;
  frame.entries[0].moveType = 7;
  expect(() => decodeServer(JSON.stringify(frame))).toThrow("INVALID_MESSAGE");
});

test("a joining observer cannot replay burst samples already covered by its baseline", () => {
  const actor = movingActor("walker", 0);
  const field = peerField([actor]);
  actor.field = field;
  actor.profile = createProfile({ mapId: "100000000", x: 0, y: 0, facing: 1 });
  for (let step = 0; step < 4; step++) {
    actor.simulation.x += 4;
    recordPeerMove(actor, field);
  }
  const baseline = actorEntity(actor);
  const path = new RemotePlayerPath(baseline, field.tick, 0);
  const entries = collectPeerMoves([actor], field);
  expect(entries).toHaveLength(4);
  for (const entry of entries) expect(path.append(entry, 0)).toBe(false);
  expect(path.current.x).toBe(baseline.position.x);
  actor.simulation.x += 4;
  recordPeerMove(actor, field);
  expect(path.append(collectPeerMoves([actor], field)[0], 30)).toBe(true);
  // A field transfer must not inherit a cursor from the retired field's queue.
  actor.field = { ...field, epoch: "replacement", tick: 1 };
  expect(actorEntity(actor).playerMotion.pathTick).toBe(1);
});
