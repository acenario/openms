import { expect, test } from "bun:test";
import { OnlineTransport } from "../src/online/transport.js";
import { ServerClock } from "../src/online/transport-clock.js";
import { inputTargetTick } from "../src/online/input-timing.js";
import { OnlineWorld } from "../../server/src/world.js";
import { decodeClient, PROTOCOL } from "../../shared/protocol.js";

function baseline() {
  return {
    snapshotId: "baseline",
    eventSeq: 1,
    serverTick: 100,
    fieldEpoch: "field",
    field: { fieldEpoch: "field" },
    revisions: {
      character: 0,
      inventory: 0,
      social: 0,
      conversation: 0,
      trade: 0,
      invitation: 0,
    },
    presentation: { interactions: [] },
  };
}
function connection(callbacks = {}) {
  const sent = [],
    closed = [];
  const transport = new OnlineTransport(callbacks);
  const socket = {
    readyState: WebSocket.OPEN,
    protocol: PROTOCOL.SUBPROTOCOL,
    bufferedAmount: 0,
    send(value) {
      sent.push(JSON.parse(value));
    },
    close(code, reason) {
      closed.push({ code, reason });
      this.readyState = WebSocket.CLOSED;
    },
  };
  Object.assign(transport, {
    socket,
    status: "synchronizing",
    connectionEpoch: "connection",
    expectedFieldEpoch: "field",
    playSession: "play",
    lastMessageAt: performance.now(),
    config: { rulesHash: "a".repeat(64), assetBuildId: "b".repeat(64) },
    limits: { commandPerSecond: 12, maxMessageBytes: 65536 },
  });
  transport.baselines.add = () => baseline();
  return { transport, socket, sent, closed };
}
function ping(transport, roundTripMs) {
  transport.receive({
    data: JSON.stringify({
      v: 1,
      type: "ping",
      connectionEpoch: "connection",
      serverTick: 100,
      serverTime: Date.now(),
      nonce: "nonce",
      roundTripMs,
    }),
  });
}

test("slow scene preparation keeps its socket, acknowledged baseline and command receipts live", async () => {
  const gate = Promise.withResolvers();
  const probe = connection({ onSnapshot: () => gate.promise });
  const t = probe.transport;
  let resolved = false;
  t.openWaiter = {
    deadline: performance.now() - 20000,
    resolve() {
      resolved = true;
    },
    reject(error) {
      throw error;
    },
  };
  try {
    const task = t.installPart({ fieldEpoch: "field" }, 0, t.generation);
    t.check();
    expect(t.lastEventSeq).toBe(1);
    expect(probe.sent.map((message) => message.type)).toEqual(["ack"]);
    expect(resolved).toBe(false);
    ping(t, 4100);
    expect(t.status).toBe("synchronizing");
    expect(probe.closed).toEqual([]);
    // An already admitted command may finish during a baseline/art refresh.
    const outcome = Promise.withResolvers();
    t.pending.set("operation", {
      fields: { operationId: "operation" },
      resolve: outcome.resolve,
    });
    await t.accept(
      {
        type: "result",
        connectionEpoch: "connection",
        eventSeq: 2,
        serverTick: 101,
        operationId: "operation",
        status: "committed",
        code: "OK",
        domainRevision: 0,
      },
      100,
      t.generation,
      performance.now(),
    );
    expect((await outcome.promise).status).toBe("committed");
    expect(t.pending.size).toBe(0);
    expect(t.lastEventSeq).toBe(2);
    gate.resolve();
    await task;
    expect(resolved).toBe(true);
    expect(t.status).toBe("active");
    expect(probe.sent.at(-1).type).toBe("ready");
  } finally {
    gate.resolve();
    t.close();
  }
});

test("a disconnect before the first baseline resumes with an authenticated zero cursor", () => {
  const { transport: t, socket, sent } = connection();
  try {
    t.disconnected("CONNECT_TIMEOUT");
    socket.readyState = WebSocket.OPEN;
    t.socket = socket;
    t.sendHello(socket, "x".repeat(43));
    const hello = decodeClient(JSON.stringify(sent.at(-1)));
    expect(hello.resume).toEqual({ playSession: "play", lastEventSeq: 0 });
    hello.resume.lastEventSeq = -1;
    expect(() => decodeClient(JSON.stringify(hello))).toThrow();
  } finally {
    t.close();
  }
});

test("clock outliers preserve the last usable estimate and the socket", () => {
  const { transport: t, closed } = connection();
  try {
    ping(t, 500);
    const before = t.clock.snapshot();
    ping(t, 4100);
    expect(t.clock.snapshot()).toEqual(before);
    expect(closed).toEqual([]);
    ping(t, 520);
    expect(t.clock.roundTripMs).toBeGreaterThanOrEqual(500);
  } finally {
    t.close();
  }
});

test("small RTT noise cannot reset the field clock from a delayed packet burst", () => {
  const clock = new ServerClock();
  const base = {
    connectionEpoch: "connection",
    fieldEpoch: "field",
    paused: false,
  };
  for (let tick = 100; tick <= 110; tick++) {
    clock.observe({
      ...base,
      serverTick: tick,
      receivedAt: 30000 + (tick - 100) * 30,
      roundTripMs: tick === 100 ? 1000 : null,
    });
  }
  const before = clock.tickOffsetMs;
  clock.observe({
    connectionEpoch: "connection",
    serverTick: 160,
    receivedAt: 31800,
    roundTripMs: 1002,
  });
  clock.observe({ ...base, serverTick: 111, receivedAt: 31801 });
  expect(Math.abs(clock.tickOffsetMs - before)).toBeLessThan(5);
});

test("arrival jitter cannot modulate the high-ping movement clock by more than one percent", () => {
  const clock = new ServerClock();
  let variation = 0;
  for (let index = 0; index <= 100; index++) {
    const before = clock.tickOffsetMs;
    const jitter = Math.floor(index / 9) % 2 ? 10 : 0;
    clock.observe({
      connectionEpoch: "connection",
      fieldEpoch: "field",
      paused: false,
      serverTick: 100 + index,
      receivedAt: 30000 + index * 30 + jitter,
      roundTripMs: index === 0 ? 2000 : null,
    });
    if (index >= 9) variation += Math.abs(clock.tickOffsetMs - before);
    const target = inputTargetTick(clock, clock.receivedAt);
    expect(target).toBeGreaterThan(clock.serverTick);
  }
  expect(variation / 3000).toBeLessThan(0.01);
  expect(clock.ready).toBe(true);
});

test("a delayed startup baseline cannot leave live high-ping input scheduled in the past", () => {
  const clock = new ServerClock();
  for (let index = 0; index <= 12; index++) {
    clock.observe({
      connectionEpoch: "connection",
      fieldEpoch: "field",
      paused: false,
      serverTick: 100 + index,
      receivedAt: 30000 + index * 30 + (index === 0 ? 25 : 0),
      roundTripMs: 2000,
    });
  }
  // Current server time + one more network leg: the input must arrive in the future.
  const actualArrivalTick = 112 + 2000 / PROTOCOL.TICK_MS;
  expect(inputTargetTick(clock, 30360)).toBeGreaterThan(actualArrivalTick);
  expect(clock.tickOffsetMs).toBeCloseTo(-26000, 5);
});

test("input schedules up to two-second RTT with jitter reach the server before their target tick", () => {
  for (const roundTripMs of [0, 100, 500, 1000, 2000, 2100]) {
    const clock = new ServerClock();
    clock.observe({
      connectionEpoch: "connection",
      fieldEpoch: "field",
      serverTick: 100,
      receivedAt: 30000,
      roundTripMs,
      paused: false,
    });
    const targetTick = inputTargetTick(clock, 30000);
    expect(clock.roundTripMs).toBe(roundTripMs);
    const actor = {
      state: "active",
      field: { epoch: "field", tick: clock.arrivalTick(30000) },
      inputSeq: 0,
      inputQueue: new Map(),
    };
    OnlineWorld.prototype.input.call(
      { closed: false, overloaded: false },
      actor,
      { fieldEpoch: "field", inputSeq: 1, targetTick },
    );
    expect(actor.inputQueue.has(targetTick)).toBe(true);
    expect(targetTick - actor.field.tick).toBeGreaterThan(0);
    expect(targetTick - actor.field.tick).toBeLessThanOrEqual(
      PROTOCOL.INPUT_LEAD_TICKS,
    );
  }
});

test("asset failure recovers on the existing socket and stale preparation is cancelled", async () => {
  let signal;
  const gate = Promise.withResolvers();
  const { transport: t, closed } = connection({
    onSnapshot: (_model, value) => {
      signal = value;
      return gate.promise;
    },
  });
  try {
    const task = t.installPart({ fieldEpoch: "field" }, 0, t.generation);
    await Promise.resolve();
    t.disconnected("CONNECTION_LOST");
    expect(signal.aborted).toBe(true);
    gate.resolve();
    await task;
    expect(t.status).toBe("disconnected");
    expect(closed).toHaveLength(1);
  } finally {
    gate.resolve();
    t.close();
  }
  const failed = connection({
    onSnapshot() {
      throw new Error("Texture unavailable");
    },
  });
  try {
    await failed.transport.installPart(
      { fieldEpoch: "field" },
      0,
      failed.transport.generation,
    );
    expect(failed.closed).toEqual([]);
    failed.transport.check();
    expect(failed.sent.at(-1).type).toBe("resync");
    expect(failed.transport.status).toBe("synchronizing");
  } finally {
    failed.transport.close();
  }
});

test("render backlog coalesces ordinary motion while retaining impulses and ordered events", async () => {
  const gate = Promise.withResolvers();
  const seen = [];
  const { transport: t } = connection({
    onSnapshot: () => gate.promise,
    onMotion: (message) => seen.push(message),
    onEvent: (message) => seen.push(message),
  });
  try {
    const task = t.installPart({ fieldEpoch: "field" }, 0, t.generation);
    for (let tick = 0; tick < 1200; tick++) {
      t.renderer.push("motion", {
        fieldEpoch: "field",
        serverTick: tick,
        authoritative: false,
        diverts: tick === 500 ? [{ vx: 1, vy: -1 }] : [],
      });
    }
    t.renderer.push("event", {
      event: { kind: "dialogue.closed", conversationId: "conversation" },
    });
    expect(t.renderer.queue.length).toBeLessThanOrEqual(5);
    gate.resolve();
    await task;
    expect(seen.some((message) => message.diverts?.length === 1)).toBe(true);
    expect(seen.at(-2).serverTick).toBe(1199);
    expect(seen.at(-1).event.kind).toBe("dialogue.closed");
  } finally {
    gate.resolve();
    t.close();
  }
});

test("same-field artwork refresh does not delay live movement observations", async () => {
  const gate = Promise.withResolvers();
  let observed = 0;
  const { transport: t } = connection({
    onSnapshot: () => gate.promise,
    onMotion: () => {
      observed++;
    },
  });
  Object.assign(t, { status: "active", model: { fieldEpoch: "field" } });
  t.renderer.fieldEpoch = "field";
  try {
    const task = t.installPart({ fieldEpoch: "field" }, 0, t.generation);
    for (let tick = 101; tick < 401; tick++) {
      t.motion(
        {
          connectionEpoch: "connection",
          fieldEpoch: "field",
          serverTick: tick,
          paused: false,
          authoritative: false,
          diverts: [],
        },
        performance.now(),
      );
    }
    expect(observed).toBe(300);
    expect(t.status).toBe("active");
    gate.resolve();
    await task;
    expect(observed).toBe(300);
  } finally {
    gate.resolve();
    t.close();
  }
});

test("exhausted asset recovery releases the pending login without losing its resume session", () => {
  const { transport: t, closed } = connection();
  let failure;
  t.presentationRetries = 3;
  t.openWaiter = {
    reject(error) {
      failure = error.code;
    },
  };
  try {
    t.presentationFailed(new Error("Texture unavailable"));
    expect(failure).toBe("PRESENTATION_FAILED");
    expect(t.openWaiter).toBeNull();
    expect(t.playSession).toBe("play");
    expect(closed).toEqual([]);
  } finally {
    t.close();
  }
});

test("a slow initial scene obtains a fresh checkpoint before enabling the first input", async () => {
  const gate = Promise.withResolvers();
  const { transport: t, sent } = connection({ onSnapshot: () => gate.promise });
  try {
    const task = t.installPart({ fieldEpoch: "field" }, 0, t.generation);
    t.baselineReceivedAt -= 20000;
    gate.resolve();
    await task;
    expect(t.status).toBe("synchronizing");
    expect(sent.at(-1).type).toBe("resync");
    expect(sent.some((message) => message.type === "ready")).toBe(false);
    t.baselines.add = () => ({
      ...baseline(),
      eventSeq: 2,
      snapshotId: "fresh",
    });
    await t.installPart({ fieldEpoch: "field" }, 0, t.generation);
    expect(t.status).toBe("active");
    expect(sent.at(-1)).toMatchObject({ type: "ready", snapshotId: "fresh" });
  } finally {
    gate.resolve();
    t.close();
  }
});

test("repeated stale scene preparation shares the bounded recovery budget", async () => {
  const { transport: t, sent, closed } = connection();
  t.callbacks.onSnapshot = () => {
    t.baselineReceivedAt -= 20000;
  };
  let code;
  t.openWaiter = {
    reject(error) {
      code = error.code;
    },
  };
  try {
    for (let attempt = 1; attempt <= 4; attempt++) {
      t.lastResyncAt = -Infinity;
      t.baselines.add = () => ({
        ...baseline(),
        eventSeq: attempt,
        snapshotId: `baseline${attempt}`,
      });
      await t.installPart({ fieldEpoch: "field" }, 0, t.generation);
    }
    expect(sent.filter((message) => message.type === "resync")).toHaveLength(3);
    expect(code).toBe("PRESENTATION_FAILED");
    expect(t.status).toBe("synchronizing");
    expect(closed).toEqual([]);
  } finally {
    t.close();
  }
});
