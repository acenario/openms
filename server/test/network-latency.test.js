import { expect, test } from "bun:test";
import { GameplayGateway } from "../src/gateway.js";
import { OnlineWorld } from "../src/world.js";
import { PROTOCOL } from "../../shared/protocol.js";
import { ServerClock } from "../../client/src/online/transport-clock.js";
import { loadContent } from "../src/content.js";
import { createSimulation } from "../../client/src/physics/simulation.js";
import { createHeldInput } from "../../shared/motion.js";
import { movementStreamView } from "../src/movement-stream.js";
const content = await loadContent();
const physics = (await content.map("100000000")).physics;

function fixture() {
  const session = { id: "session", accountId: "account" };
  const actor = {
    id: "actor",
    sessionId: session.id,
    playSession: "play",
    eventSeq: 1,
    field: { epoch: "field", tick: 100 },
    state: "active",
    inputSeq: 0,
    inputQueue: new Map(),
    attackEdges: [],
    receivedAttack: false,
    profile: { hp: 100 },
    input: createHeldInput(),
    simulation: createSimulation(physics, { x: 80, y: 274 }),
  };
  const world = new OnlineWorld({ content: {}, database: {} });
  const gateway = new GameplayGateway({
    config: { maxConnections: 10 },
    world,
    database: {},
    auth: { origin() {}, session: () => session, active: () => true },
  });
  const socket = {
    data: null,
    sent: [],
    readyState: 1,
    send(frame) {
      this.sent.push(JSON.parse(frame));
      return 1;
    },
    getBufferedAmount: () => 0,
    close() {},
  };
  gateway.upgrade(
    new Request("http://localhost/api/v1/play", {
      headers: { "sec-websocket-protocol": PROTOCOL.SUBPROTOCOL },
    }),
    {
      upgrade(_request, options) {
        socket.data = options.data;
        return true;
      },
    },
    "local",
  );
  gateway.attach(socket, actor);
  socket.data.ready = true;
  movementStreamView(actor);
  return { gateway, actor, socket, world };
}
function input(probe, sequence, targetTick, extra = {}) {
  probe.gateway.message(
    probe.socket,
    JSON.stringify({
      v: 1,
      type: "input",
      connectionEpoch: probe.socket.data.epoch,
      seq: sequence,
      inputSeq: sequence,
      fieldEpoch: "field",
      targetTick,
      motionEpoch: probe.actor.movementStream.epoch,
      motionConfig: probe.actor.movementStream.configurations.at(-1).version,
      movementLocked: false,
      impulses: [],
      motion: { x: 80, y: 274, vx: 0, vy: 0 },
      horizontal: 1,
      vertical: 0,
      jump: false,
      attack: false,
      ...extra,
    }),
  );
}

test("delayed ordinary movement can arrive in a burst without disconnecting or losing fresh edges", () => {
  const probe = fixture();
  probe.actor.field.tick = 200;
  for (let sequence = 1; sequence <= 20; sequence++) {
    input(probe, sequence, 100 + sequence);
  }
  input(probe, 21, 121, { jump: true });
  input(probe, 22, 122, { attack: true });
  expect(probe.socket.data.closed).toBe(false);
  expect(probe.actor.inputQueue.get(121).jump).toBe(true);
  expect(probe.actor.inputQueue.get(122).attack).toBe(true);
  expect(probe.actor.field.tick).toBe(200);
  expect(probe.actor.ackInputSeq).toBeUndefined();
  expect(probe.actor.inputQueue.size).toBe(22);
});

test("a forged path gap is rejected and sustained traffic remains bounded", () => {
  const invalid = fixture();
  input(invalid, 1, 1000);
  expect(invalid.socket.data.closed).toBe(true);
  expect(invalid.socket.sent.at(-1).code).toBe("INVALID_MESSAGE");
  const probe = fixture();
  for (let sequence = 1; sequence <= 200; sequence++) {
    input(probe, sequence, 100 + sequence);
  }
  expect(probe.socket.data.closed).toBe(true);
  expect(probe.socket.sent.at(-1).code).toBe("RATE_LIMITED");
});

test("zero-cursor resume rotates ownership only for the same authenticated play session", async () => {
  const probe = fixture();
  let rotations = 0;
  probe.gateway.database.rotateLease = async () => {
    rotations++;
  };
  const resume = { playSession: "play", lastEventSeq: 0 };
  const actor = await probe.gateway.resumeActor(
    probe.socket,
    probe.actor,
    "actor",
    resume,
  );
  expect(actor).toBe(probe.actor);
  expect(rotations).toBe(1);
  for (const forged of [undefined, { ...resume, playSession: "other" }]) {
    await expect(
      probe.gateway.resumeActor(probe.socket, actor, "actor", forged),
    ).rejects.toThrow("CHARACTER_BUSY");
  }
  expect(
    probe.gateway.admitsResume(
      { data: { session: { id: "other" } } },
      actor,
      "actor",
      resume,
    ),
  ).toBe(false);
});

test("disconnect releases a map preparation waiter promptly", () => {
  const probe = fixture();
  let ready;
  probe.actor.transition = {
    ready(value) {
      ready = value;
    },
  };
  probe.gateway.closed(probe.socket, 1000, "CONNECTION_LOST");
  expect(ready).toBe(false);
  expect(probe.actor.connection).toBeNull();
  expect(probe.actor.disconnectedAt).toBeNumber();
});

test("entry heartbeats calibrate RTT before the ordinary fifteen-second interval", () => {
  const probe = fixture();
  probe.gateway.ping(probe.socket, Date.now());
  for (let index = 0; index < 3; index++) {
    probe.gateway.pong(probe.socket, { nonce: probe.socket.data.nonce });
  }
  expect(probe.socket.sent).toHaveLength(4);
  expect(probe.socket.sent[1].roundTripMs).toBeNumber();
  expect(probe.socket.sent[3].roundTripMs).toBeNumber();
  expect(probe.socket.data.warmupPings).toBe(0);
  probe.gateway.pong(probe.socket, { nonce: probe.socket.data.nonce });
  expect(probe.socket.sent).toHaveLength(4);
  expect(probe.socket.data.nonce).toBeNull();
});

test.each([0, 1])(
  "loading-delayed entry probe %i does not block movement and attacks until the next heartbeat",
  (stalledProbe) => {
    const probe = fixture();
    const clock = new ServerClock();
    probe.gateway.ping(probe.socket, Date.now());
    let received = 0;
    // Real network RTT is 30 ms. One browser startup stall delays a pong by
    // another 870 ms; the server clock still advances throughout that stall.
    for (let index = 0; index < 4; index++) {
      const roundTripMs = index === stalledProbe ? 900 : 30;
      const ping = probe.socket.sent[received++];
      if (!ping) break;
      clock.observe({
        ...ping,
        receivedAt: ping.serverTick * PROTOCOL.TICK_MS + 15,
      });
      probe.actor.field.tick += Math.ceil(roundTripMs / PROTOCOL.TICK_MS);
      probe.socket.data.pingMonotonic = performance.now() - roundTripMs;
      probe.gateway.pong(probe.socket, { nonce: ping.nonce });
    }
    // Use the actual server tick after the network round trip, not the client's
    // estimated arrival tick: a bad estimate must fail real server admission.
    clock.observe({
      connectionEpoch: probe.socket.data.epoch,
      fieldEpoch: "field",
      serverTick: probe.actor.field.tick,
      receivedAt: 30000,
      paused: false,
    });
    const targetTick = probe.actor.movementStream.tick + 1;
    probe.actor.field.tick += 1;
    const tick = probe.actor.field.tick;
    input(probe, 1, targetTick, {
      attack: true,
      motion: { x: 120, y: 0, vx: 125, vy: 0 },
    });
    expect(probe.actor.inputQueue.get(targetTick)).toMatchObject({
      horizontal: 1,
      motion: { x: 120, y: 0, vx: 125, vy: 0 },
    });
    expect(probe.actor.attackEdges).toHaveLength(0);
    expect(probe.actor.field.tick).toBe(tick);
    expect(probe.socket.data.closed).toBe(false);
  },
);

test("dialogue prose uses the event frame budget and retains a private fallback for oversized pages", async () => {
  const { storeDialogue, publishInteraction } =
    await import("../src/interaction-common.js");
  const { decodeServer } = await import("../../shared/protocol.js");
  const events = [];
  const world = {
    publish(_actor, message) {
      events.push(message);
    },
  };
  const actor = { id: "actor", state: "active", field: { epoch: "field" } };
  const lease = { npcTemplateId: 1012000, expiresAt: Date.now() + 5000 };
  for (const prose of ["An ordinary page.", "x".repeat(65000)]) {
    const contentId = storeDialogue(world, actor, lease, prose);
    publishInteraction(world, actor, {
      kind: "dialogue",
      conversationId: "conversation",
      step: 1,
      npcId: "npc",
      npcTemplateId: 1012000,
      contentId,
      native: {
        kind: "say",
        speaker: 0,
        prev: false,
        next: true,
        defaultValue: null,
      },
      choices: [],
      input: "next",
      minimum: null,
      maximum: null,
    });
    const frame = {
      ...events.at(-1),
      v: 1,
      connectionEpoch: "connection",
      serverTick: 1,
      eventSeq: 1,
    };
    expect(() => decodeServer(JSON.stringify(frame))).not.toThrow();
    expect(Buffer.byteLength(JSON.stringify(frame))).toBeLessThan(
      PROTOCOL.MAX_SERVER_MESSAGE_BYTES,
    );
  }
  expect(events[0].event.text).toBe("An ordinary page.");
  expect(events[1].event.text).toBeUndefined();
  expect(events[1].event.contentId).toBeString();
});

test("map downloads finish before any durable transaction begins", async () => {
  const { loadContent } = await import("../src/content.js");
  const { createProfile } =
    await import("../../client/src/profile/profile-validation.js");
  const { transitionActor, settleTransitionReady } =
    await import("../src/field-transition.js");
  const content = await loadContent();
  const offered = Promise.withResolvers();
  let transactions = 0;
  const world = new OnlineWorld({
    content,
    database: {},
    publish(_actor, message) {
      if (message.phase === "prepare") offered.resolve(message);
    },
  });
  const field = await world.fieldFor(100000000);
  const actor = {
    id: "traveler",
    profile: createProfile({ mapId: field.manifest.id, x: 0, y: 0, facing: 1 }),
    session: { expiresAt: Date.now() + 180000 },
  };
  world.prepareEntry(actor, field);
  const { prepareActorWorldActions } =
    await import("../src/field-world-actions.js");
  await prepareActorWorldActions(world, actor);
  actor.state = "active";
  field.characters.set(actor.id, actor);
  actor.connection = { data: { ready: true, baselines: new Map() } };
  world.participants.commit = async () => {
    transactions++;
    return { status: "rejected", code: "SERVER_BUSY" };
  };
  const work = transitionActor(
    world,
    actor,
    { mapId: 104000000, portal: 0 },
    {},
  );
  const preparation = await Promise.race([
    offered.promise,
    work.then(() => {
      throw new Error("Travel ended before preparation");
    }),
  ]);
  expect(transactions).toBe(0);
  expect(preparation.deadline - Date.now()).toBeGreaterThan(15000);
  settleTransitionReady(world, actor, {
    transitionId: preparation.transitionId,
    fieldEpoch: field.epoch,
    accepted: true,
  });
  await work;
  expect(transactions).toBe(1);
  expect(actor.state).toBe("active");
});
