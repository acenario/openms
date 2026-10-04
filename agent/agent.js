// Browserless agent body: socket client + reflex layer + event log + goal endpoint.
// Usage: bun agent/agent.js --name Lumen [--game http://127.0.0.1:3102] [--port 3310]
// Goals (POST /goal): {type:"say",text} {type:"follow",name} {type:"goto",x} {type:"jump"}
//                     {type:"crouch",ms} {type:"stop"}        GET /state
// ponytail: single-file reflex layer; split behaviors out once there are more than a few.
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { connect, trace } from "./socket-client.js";

const { values: opts } = parseArgs({
  options: {
    name: { type: "string", default: "Lumen" },
    game: { type: "string", default: "http://127.0.0.1:3102" },
    port: { type: "string", default: "3310" },
  },
  strict: true,
});

const LOGS = join(import.meta.dir, "logs");
mkdirSync(LOGS, { recursive: true });
// Version covers every file that shapes behavior, so episodes compare like with like.
const VERSION = createHash("sha256")
  .update(readFileSync(new URL(import.meta.url)))
  .update(readFileSync(new URL("./socket-client.js", import.meta.url)))
  .digest("hex")
  .slice(0, 8);
const TICK_MS = 50;
const STUCK_TICKS = 16; // ~0.8 s without horizontal progress
const NEAR_X = 50;
const RELAUNCH_DELAY_MS = 5000;

const log = (file, record) =>
  appendFileSync(join(LOGS, file), JSON.stringify({ t: new Date().toISOString(), ...record }) + "\n");
const event = (record) => {
  log("events.jsonl", record);
  console.log("[event]", JSON.stringify(record));
};

// ---------- perception ----------
function perceive(body) {
  const m = body.transport.model;
  const sim = body.self();
  if (!m?.self?.entity || !sim) return null;
  const list = Array.isArray(m.entities) ? m.entities : [...(m.entities?.values?.() ?? [])];
  const selfId = m.self.entity.id;
  const pos = (e) => ({ x: Math.round(e.position?.x ?? 0), y: Math.round(e.position?.y ?? 0) });
  return {
    mapId: m.field?.mapId ?? null,
    self: {
      x: Math.round(sim.x),
      y: Math.round(sim.y),
      state: sim.state,
      hp: m.self.hp,
      maxHp: m.self.maxHp,
      mp: m.self.mp,
      maxMp: m.self.maxMp,
      level: m.self.level,
    },
    players: list
      .filter((e) => e.kind === "player" && e.id !== selfId)
      .map((e) => ({ id: e.id, name: e.appearance?.name ?? null, ...pos(e) })),
    mobs: list
      .filter((e) => e.kind === "mob" && (e.mobState?.hp ?? 1) > 0)
      .map((e) => ({ id: e.id, templateId: e.templateId, ...pos(e) })),
    npcs: list.filter((e) => e.kind === "npc").map((e) => ({ id: e.id, templateId: e.templateId, ...pos(e) })),
    drops: list.filter((e) => e.kind === "drop").length,
  };
}

// ---------- reflex layer (virtual keys) ----------
function steer(held, dir) {
  held.left = dir === "left";
  held.right = dir === "right";
}
function jump(held) {
  held.jump = true;
  held.jumpPressed = true;
  setTimeout(() => (held.jump = false), 90);
}

let goal = { type: "idle" };
let episode = null;
const stuck = { lastX: null, ticks: 0, lastJump: 0 };

function startEpisode(newGoal, world) {
  endEpisode("replaced", world);
  goal = newGoal;
  if (goal.type === "idle") return;
  episode = {
    goal,
    version: VERSION,
    started: Date.now(),
    start: world?.self ?? null,
    metrics: { distance: 0, jumps: 0, stuck: 0, hpLost: 0, nearTicks: 0, ticks: 0 },
    lastSelf: world?.self ?? null,
  };
}

function endEpisode(outcome, world, reason = null) {
  if (!episode) return;
  const { lastSelf, ...rest } = episode;
  log("episodes.jsonl", { ...rest, outcome, reason, durationMs: Date.now() - episode.started, end: world?.self ?? lastSelf });
  episode = null;
  goal = { type: "idle" };
}

function track(world) {
  if (!episode) return;
  const m = episode.metrics;
  const prev = episode.lastSelf;
  m.ticks++;
  if (prev) {
    m.distance += Math.abs(world.self.x - prev.x) + Math.abs(world.self.y - prev.y);
    m.hpLost += Math.max(0, prev.hp - world.self.hp);
  }
  episode.lastSelf = world.self;
}

function approach(held, world, tx, ty) {
  const dx = tx - world.self.x;
  if (Math.abs(dx) <= NEAR_X) {
    steer(held, null);
    stuck.ticks = 0;
    return true;
  }
  steer(held, dx > 0 ? "right" : "left");
  const moved = stuck.lastX === null || Math.abs(world.self.x - stuck.lastX) >= 1;
  stuck.ticks = moved ? 0 : stuck.ticks + 1;
  stuck.lastX = world.self.x;
  const targetAbove = ty < world.self.y - 60 && Math.abs(dx) < 150;
  if ((stuck.ticks >= STUCK_TICKS || targetAbove) && Date.now() - stuck.lastJump > 700) {
    if (stuck.ticks >= STUCK_TICKS && episode) episode.metrics.stuck++;
    if (episode) episode.metrics.jumps++;
    stuck.lastJump = Date.now();
    stuck.ticks = 0;
    jump(held);
  }
  return false;
}

function act(held, world) {
  track(world);
  if (goal.type === "follow") {
    const target = world.players.find((p) => p.name?.toLowerCase() === goal.name.toLowerCase());
    if (!target) {
      steer(held, null);
      if (Date.now() - episode.started > 30000 && !episode.metrics.nearTicks)
        endEpisode("failed", world, "target not on this map");
      return;
    }
    if (approach(held, world, target.x, target.y)) episode.metrics.nearTicks++;
  } else if (goal.type === "goto") {
    if (approach(held, world, goal.x, world.self.y)) endEpisode("success", world);
    else if (Date.now() - episode.started > 30000) endEpisode("timeout", world);
  } else {
    steer(held, null);
  }
}

// ---------- events for the LLM ----------
let known = null;
function noticeChanges(world) {
  const names = new Set(world.players.map((p) => p.name));
  if (known) {
    for (const n of names) if (!known.players.has(n)) event({ kind: "player-arrived", name: n });
    for (const n of known.players) if (!names.has(n)) event({ kind: "player-left", name: n });
    if (world.mapId !== known.mapId) event({ kind: "map", mapId: world.mapId });
    if (world.self.hp < known.hp * 0.7) event({ kind: "hurt", hp: world.self.hp, maxHp: world.self.maxHp });
  }
  known = { players: names, mapId: world.mapId, hp: world.self.hp };
}

// ---------- goal endpoint ----------
function serve(live) {
  Bun.serve({
    hostname: "127.0.0.1",
    port: Number(opts.port),
    async fetch(req) {
      const url = new URL(req.url);
      const body = live.body;
      if (req.method === "GET" && url.pathname === "/state")
        return Response.json({ online: Boolean(body), goal, version: VERSION, world: live.world });
      if (req.method !== "POST" || url.pathname !== "/goal") return new Response("not found", { status: 404 });
      if (!body) return Response.json({ ok: false, error: "offline (reconnecting)" }, { status: 503 });
      const g = await req.json();
      try {
        if (g.type === "say") {
          const result = await body.transport.command({ kind: "chat.send", channel: "map", text: String(g.text).slice(0, 70) });
          return Response.json({ ok: true, result: result?.status ?? result });
        }
        if (g.type === "jump") {
          jump(body.held);
          return Response.json({ ok: true });
        }
        if (g.type === "crouch") {
          body.held.down = true;
          setTimeout(() => (body.held.down = false), Math.min(Number(g.ms) || 800, 10000));
          return Response.json({ ok: true });
        }
        if (!["follow", "goto", "idle", "stop"].includes(g.type))
          return Response.json({ ok: false, error: "unknown goal" }, { status: 400 });
        startEpisode(g.type === "stop" ? { type: "idle" } : g, live.world);
        return Response.json({ ok: true, goal });
      } catch (e) {
        return Response.json({ ok: false, error: e.message }, { status: 500 });
      }
    },
  });
}

// ---------- supervisor ----------
async function lifetime(live) {
  let dropped = null;
  let inWorld = false; // statuses during connect retries (e.g. CHARACTER_BUSY) are not drops
  const body = await connect({
    name: opts.name,
    game: opts.game,
    onEvent: (e) => {
      const ev = e.event ?? e;
      if (ev.kind === "chat" && ev.senderName !== opts.name)
        event({ kind: "chat", from: ev.senderName, text: ev.text, channel: ev.channel });
    },
    onStatus: (s) => {
      const status = typeof s === "string" ? s : s?.status;
      if (inWorld && status === "disconnected" && !dropped) {
        dropped = `disconnected: ${s?.code ?? "unknown"}`;
        if (s?.code === "INVALID_MESSAGE") log("protocol-trace.jsonl", { code: s.code, ...trace });
      }
    },
  });
  live.body = body;
  inWorld = true;
  console.log(`[agent] ${body.character} in world, no browser (version ${VERSION}); goals on http://127.0.0.1:${opts.port}`);
  event({ kind: "online", name: body.character, version: VERSION, client: "socket" });
  try {
    while (!dropped) {
      const started = Date.now();
      const world = perceive(body);
      if (world) {
        live.world = world;
        noticeChanges(world);
        act(body.held, world);
      }
      await Bun.sleep(Math.max(0, TICK_MS - (Date.now() - started)));
    }
    return dropped;
  } finally {
    live.body = null;
    await body.close();
  }
}

const live = { body: null, world: null };
serve(live);
for (;;) {
  let reason;
  try {
    reason = await lifetime(live);
  } catch (e) {
    reason = `connect failed: ${e.message}`;
  }
  endEpisode("interrupted", live.world, reason);
  console.log(`[agent] offline: ${reason}; reconnecting in ${RELAUNCH_DELAY_MS / 1000}s`);
  event({ kind: "offline", reason });
  await Bun.sleep(RELAUNCH_DELAY_MS);
}
