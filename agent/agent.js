// Agent body: browserless socket client + supervisor + HTTP port + logs. Behaviors live in
// brain.js, which is hot-reloaded when saved (socket, goal and episode survive the reload).
// Usage: bun agent/agent.js --name Lumen [--game http://127.0.0.1:3102] [--port 3310]
// API (see brain.js handle()): GET /state /context /character, POST /goal {type:...}
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { connect, trace } from "./socket-client.js";
import { atlas } from "./atlas.js";
import { memory } from "./memory.js";

const { values: opts } = parseArgs({
  options: {
    name: { type: "string", default: "Lumen" },
    game: { type: "string", default: "http://127.0.0.1:3102" },
    port: { type: "string", default: "3310" },
    "database-url": { type: "string" }, // agent memory (schema `agent`); default: local dev DB
  },
  strict: true,
});

const LOGS = join(import.meta.dir, "logs", opts.name.toLowerCase()); // one folder per agent
mkdirSync(LOGS, { recursive: true });
const TICK_MS = 50;
const RELAUNCH_DELAY_MS = 5000;
const BRAIN = join(import.meta.dir, "brain.js");

// JSONL stays the durable local log; Postgres is the queryable, cross-agent mirror.
const db = memory(opts["database-url"]);
let dbWarned = false;
const mirror = (file, record) => {
  const write = file === "events.jsonl" ? db.event(opts.name, record) : file === "episodes.jsonl" ? db.episode(opts.name, record) : null;
  write?.catch((e) => {
    if (!dbWarned) console.log("[agent] memory DB unavailable (JSONL still written):", e.message);
    dbWarned = true;
  });
};
// ---------- event stream for the deciding model (GET /wait, GET /events) ----------
// Every event gets a sequence number; a finished episode becomes a compact "goal-done" event, so
// the model can act → wait for the outcome → decide, instead of polling /state and sleeping.
const RING_SIZE = 1000;
const ring = [];
let seq = 0;
const waiters = new Set();
const DEFAULT_WAIT = ["chat", "npc", "npc-closed", "goal-done", "level-up", "hurt", "retreat", "map", "player-arrived", "reflex", "resume"];
function publish(record) {
  ring.push({ seq: ++seq, ...record });
  if (ring.length > RING_SIZE) ring.shift();
  for (const wake of waiters) wake();
}
function goalDone(episode) {
  const g = episode.goal ?? {};
  const goal = Object.fromEntries(Object.entries(g).filter(([k]) => ["type", "name", "map", "x", "y", "limit", "mob", "npc"].includes(k)));
  return { kind: "goal-done", t: episode.t, goal, outcome: episode.outcome, reason: episode.reason ?? null, durationMs: episode.durationMs, metrics: episode.metrics };
}
async function waitFor(url) {
  const kinds = new Set((url.searchParams.get("kinds") ?? DEFAULT_WAIT.join(",")).split(",").filter(Boolean));
  const since = Number(url.searchParams.get("since") ?? seq); // default: only what happens next
  const timeoutMs = Math.min(Math.max(Number(url.searchParams.get("timeout") ?? 30), 0), 120) * 1000;
  const match = () => ring.filter((e) => e.seq > since && (kinds.has("*") || kinds.has(e.kind)));
  let found = match();
  if (!found.length && timeoutMs) {
    await new Promise((resolve) => {
      const wake = () => match().length && done();
      const timer = setTimeout(() => done(), timeoutMs);
      const done = () => (clearTimeout(timer), waiters.delete(wake), resolve());
      waiters.add(wake);
    });
    found = match();
  }
  return Response.json({ seq, events: found, timedOut: !found.length });
}

let overlayHash = null; // this agent's brains/<Name>.js hash (set by loadBrain); null = base brain only
const log = (file, record) => {
  const stamped = { t: new Date().toISOString(), ...record, ...(file === "episodes.jsonl" ? { overlay: overlayHash } : {}) };
  appendFileSync(join(LOGS, file), JSON.stringify(stamped) + "\n");
  mirror(file, stamped);
  if (file === "events.jsonl") publish(stamped);
  else if (file === "episodes.jsonl") publish(goalDone(stamped));
};
const event = (record) => {
  log("events.jsonl", record);
  console.log("[event]", JSON.stringify(record));
};
// Version covers every file that shapes behavior, so episodes compare like with like.
const versionNow = () =>
  createHash("sha256")
    .update(readFileSync(new URL(import.meta.url)))
    .update(readFileSync(BRAIN))
    .update(readFileSync(new URL("./socket-client.js", import.meta.url)))
    .update(existsSync(OVERLAY) ? readFileSync(OVERLAY) : "") // per-agent brains version separately
    .digest("hex")
    .slice(0, 8);

const live = { body: null, world: null };
const sharedAtlas = atlas(new URL(opts.game).origin); // caches survive brain reloads

// ---------- hot reload ----------
let brain = null;
let brainMtime = 0;
// brain.js re-imports nav.js on every load, so a nav.js save reloads the brain too.
const NAV = join(import.meta.dir, "nav.js");
// Per-agent overlay on the shared base brain: brains/<Name>.js exports `overlay(base)` returning hooks
// (tick, onEvent, handle, perceive, ...) that replace or wrap the base's. No file = the base brain.
const OVERLAY = join(import.meta.dir, "brains", `${opts.name}.js`);
const mtimeOf = (f) => statSync(f, { throwIfNoEntry: false })?.mtimeMs ?? 0;
const brainFilesMtime = () => Math.max(mtimeOf(BRAIN), mtimeOf(NAV), mtimeOf(OVERLAY));
async function loadBrain() {
  const mtime = brainFilesMtime();
  if (brain && mtime === brainMtime) return;
  const base = await import(`${BRAIN}?v=${mtime}`); // a new specifier forces a fresh module
  const version = versionNow();
  base.attach({ opts, log, event, live, version, atlas: sharedAtlas });
  if (brain) base.restore(brain.snapshot());
  const custom = existsSync(OVERLAY) ? await import(`${OVERLAY}?v=${mtime}`) : null;
  overlayHash = custom ? createHash("sha256").update(readFileSync(OVERLAY)).digest("hex").slice(0, 8) : null;
  const fresh = custom ? { ...base, ...custom.overlay(base, { opts, log, event, live }) } : base;
  const first = !brain;
  brain = fresh;
  brainMtime = mtime;
  if (!first) event({ kind: "brain-reloaded", version });
}
async function checkBrain() {
  try {
    await loadBrain();
  } catch (e) {
    // A broken save keeps the previous brain running; fix the file and save again.
    brainMtime = brainFilesMtime();
    event({ kind: "brain-reload-failed", error: e.message });
  }
}
await loadBrain();
setInterval(checkBrain, 1000);

Bun.serve({
  hostname: "127.0.0.1",
  port: Number(opts.port),
  idleTimeout: 0, // Bun's 10 s default cut /wait long-polls (up to 120 s); loopback-only, so no timeout
  // /wait and /events live in the body so they survive brain reloads; everything else is the brain's.
  //   GET /wait?since=<seq>&kinds=goal-done,chat,...&timeout=30   blocks until a matching event (max 120 s)
  //   GET /events?since=<seq>&kinds=*                             returns immediately
  fetch: (req) => {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/wait") return waitFor(url);
    if (req.method === "GET" && url.pathname === "/events") {
      url.searchParams.set("timeout", "0");
      if (!url.searchParams.has("since")) url.searchParams.set("since", "0");
      return waitFor(url);
    }
    return brain.handle(req);
  },
});

// ---------- supervisor ----------
async function lifetime() {
  let dropped = null;
  let inWorld = false; // statuses during connect retries (e.g. CHARACTER_BUSY) are not drops
  const body = await connect({
    name: opts.name,
    game: opts.game,
    onEvent: (e) => brain.onEvent(e.event ?? e),
    onStatus: (s) => {
      const status = typeof s === "string" ? s : s?.status;
      if (inWorld && status === "disconnected" && !dropped) {
        dropped = `disconnected: ${s?.code ?? "unknown"}`;
        if (s?.code === "INVALID_MESSAGE") log("protocol-trace.jsonl", { code: s.code, ...trace });
      }
    },
  });
  live.body = body;
  live.resumed = false;
  inWorld = true;
  const version = versionNow();
  console.log(`[agent] ${body.character} in world, no browser (version ${version}); goals on http://127.0.0.1:${opts.port}`);
  event({ kind: "online", name: body.character, version, client: "socket" });
  try {
    while (!dropped) {
      const started = Date.now();
      try {
        const worldNow = brain.perceive(body);
        if (worldNow) {
          if (worldNow.mapId !== live.laddersMap) {
            live.laddersMap = worldNow.mapId;
            sharedAtlas.context(worldNow.mapId).then(
              (c) => ((live.ladders = c.ladders), (live.exits = c.exits)),
              () => ((live.ladders = []), (live.exits = [])),
            );
          }
          live.world = worldNow;
          if (!live.resumed) (live.resumed = true), resumeGoal().catch((e) => event({ kind: "resume", error: e.message }));
          brain.tick(body, worldNow);
        }
      } catch (e) {
        // A behavior bug must not kill the body; log it and keep the socket alive.
        if (Date.now() - (live.lastTickError ?? 0) > 5000) event({ kind: "tick-error", error: e.message });
        live.lastTickError = Date.now();
      }
      await Bun.sleep(Math.max(0, TICK_MS - (Date.now() - started)));
    }
    return dropped;
  } finally {
    live.body = null;
    await body.close();
  }
}

// ---------- goal resume across reconnects and restarts ----------
// The active goal is saved when the connection drops or the body stops, and re-issued through the
// normal goal API once back in the world (so travel re-plans its route from wherever we are).
const RESUME_FILE = join(LOGS, "resume-goal.json");
function apiGoal(goal) {
  if (!goal || goal.type === "idle") return null;
  if (goal.type === "talk") return null; // conversations do not survive a reconnect
  const keep = ["type", "name", "map", "x", "y", "limit", "mob", "skill"];
  const api = Object.fromEntries(Object.entries(goal).filter(([k, v]) => keep.includes(k) && v !== undefined));
  if (goal.mobs?.length) api.mob = goal.mobs; // hunt keeps resolved ids; the API accepts a list
  return api;
}
function saveResume() {
  const goal = apiGoal(brain.snapshot().goal);
  writeFileSync(RESUME_FILE, JSON.stringify({ goal, savedAt: new Date().toISOString() })); // sync: shutdown exits next
}
async function resumeGoal() {
  const saved = await Bun.file(RESUME_FILE).json().catch(() => null);
  if (!saved?.goal) return;
  await Bun.write(RESUME_FILE, JSON.stringify({ goal: null }));
  const reply = await brain.handle(new Request("http://agent/goal", { method: "POST", body: JSON.stringify(saved.goal) }));
  event({ kind: "resume", goal: saved.goal, result: (await reply.json().catch(() => ({}))).ok ?? false });
}

// Clean shutdown (SIGTERM/SIGINT, e.g. from run.js): log out so the character is free at once
// instead of waiting out the server's ~30 s reconnect grace.
let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  saveResume();
  brain.endEpisode("interrupted", live.world, `shutdown (${signal})`);
  event({ kind: "offline", reason: `shutdown (${signal})` });
  try {
    await live.body?.close(); // revoke() + close
  } finally {
    process.exit(0);
  }
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

for (;;) {
  let reason;
  try {
    reason = await lifetime();
  } catch (e) {
    reason = `connect failed: ${e.message}`;
  }
  if (brain.snapshot().goal?.type !== "idle") saveResume(); // keep an earlier save across failed retries
  brain.endEpisode("interrupted", live.world, reason);
  console.log(`[agent] offline: ${reason}; reconnecting in ${RELAUNCH_DELAY_MS / 1000}s`);
  event({ kind: "offline", reason });
  await Bun.sleep(RELAUNCH_DELAY_MS);
}
