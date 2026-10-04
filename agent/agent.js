// Agent body: browserless socket client + supervisor + HTTP port + logs. Behaviors live in
// brain.js, which is hot-reloaded when saved (socket, goal and episode survive the reload).
// Usage: bun agent/agent.js --name Lumen [--game http://127.0.0.1:3102] [--port 3310]
// API (see brain.js handle()): GET /state /context /character, POST /goal {type:...}
import { appendFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
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
const log = (file, record) => {
  const stamped = { t: new Date().toISOString(), ...record };
  appendFileSync(join(LOGS, file), JSON.stringify(stamped) + "\n");
  mirror(file, stamped);
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
    .digest("hex")
    .slice(0, 8);

const live = { body: null, world: null };
const sharedAtlas = atlas(new URL(opts.game).origin); // caches survive brain reloads

// ---------- hot reload ----------
let brain = null;
let brainMtime = 0;
async function loadBrain() {
  const mtime = statSync(BRAIN).mtimeMs;
  if (brain && mtime === brainMtime) return;
  const fresh = await import(`${BRAIN}?v=${mtime}`); // a new specifier forces a fresh module
  const version = versionNow();
  fresh.attach({ opts, log, event, live, version, atlas: sharedAtlas });
  if (brain) fresh.restore(brain.snapshot());
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
    brainMtime = statSync(BRAIN).mtimeMs;
    event({ kind: "brain-reload-failed", error: e.message });
  }
}
await loadBrain();
setInterval(checkBrain, 1000);

Bun.serve({
  hostname: "127.0.0.1",
  port: Number(opts.port),
  fetch: (req) => brain.handle(req),
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

for (;;) {
  let reason;
  try {
    reason = await lifetime();
  } catch (e) {
    reason = `connect failed: ${e.message}`;
  }
  brain.endEpisode("interrupted", live.world, reason);
  console.log(`[agent] offline: ${reason}; reconnecting in ${RELAUNCH_DELAY_MS / 1000}s`);
  event({ kind: "offline", reason });
  await Bun.sleep(RELAUNCH_DELAY_MS);
}
