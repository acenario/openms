// Orchestrator feed: one line per thing worth acting on, across every agent and the game.
//   bun agent/orchestrate.js            (stream; built for Monitor — each line is a notification)
// Watches logs/<agent>/events.jsonl for all agents, knowledge/Learned/Board.md, .locks/ and
// logs/devwatch/devwatch.out. Polls once a second; prints only new, notable items.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const DIR = import.meta.dir;
const LOGS = join(DIR, "logs");
const BOARD = join(DIR, "knowledge", "Learned", "Board.md");
const LOCKS = join(DIR, ".locks");
const DEVWATCH = join(LOGS, "devwatch", "devwatch.out");
const OFFLINE_ALERT_MS = 60000;
const STALE_LOCK_MS = 20 * 60000;

const say = (line) => console.log(`${new Date().toISOString().slice(11, 19)} ${line}`);
const offsets = new Map();
/** New complete lines appended to a file since the last call (starts at the current end). */
function fresh(file) {
  if (!existsSync(file)) return [];
  const size = statSync(file).size;
  if (!offsets.has(file)) return (offsets.set(file, size), []);
  const from = offsets.get(file);
  if (size <= from) return (offsets.set(file, size), []);
  const text = readFileSync(file, "utf8").slice(from);
  const cut = text.lastIndexOf("\n") + 1;
  offsets.set(file, from + Buffer.byteLength(text.slice(0, cut)));
  return text.slice(0, cut).split("\n").filter(Boolean);
}

const offlineSince = new Map(); // agent -> ms
const alerted = new Set();
const lastMap = new Map();
function agentEvent(agent, e) {
  const who = agent[0].toUpperCase() + agent.slice(1);
  switch (e.kind) {
    case "level-up":
      return say(`⬆ ${who} reached level ${e.level} (${e.ap} AP to spend)`);
    case "map":
      if (lastMap.get(agent) !== e.mapId) say(`🗺 ${who} → map ${e.mapId}`);
      return lastMap.set(agent, e.mapId);
    case "npc":
      if (e.quest && ["accepted", "confirm"].includes(e.quest.mode))
        say(`📜 ${who} · ${e.npc} · quest ${e.quest.id} "${e.quest.name}" ${e.quest.mode === "accepted" ? "accepted/updated" : `confirm (stage ${e.quest.stage})`}`);
      return;
    case "chat":
      // Humans = anyone who isn't one of our agents' characters (names can change: rename.js).
      if (e.from && !agentCharacters.has(String(e.from).toLowerCase())) say(`💬 ${e.from} → ${who}'s map: ${String(e.text).slice(0, 160)}`);
      return;
    case "offline":
      if (!offlineSince.has(agent)) offlineSince.set(agent, Date.now());
      // A server-initiated close for a protocol/motion reason is a bug signal (tonight: post-portal knockback).
      if (/NOT_ALLOWED|INVALID_MESSAGE|SERVER_BUSY|RESYNC_REQUIRED/.test(e.reason ?? "")) say(`🚨 ${who} kicked by server: ${e.reason}`);
      return;
    case "online":
      if (alerted.has(agent)) say(`✅ ${who} back online`);
      offlineSince.delete(agent);
      alerted.delete(agent);
      return;
    case "tick-error":
    case "brain-reload-failed":
      return say(`⚠ ${who} ${e.kind}: ${String(e.error).slice(0, 160)}`);
    case "died": // brain.js emits it once per death, with where and what it was doing
      return say(`💀 ${who} died on map ${e.mapId} at (${e.x}, ${e.y}) during ${e.goal ?? "idle"}`);
    case "retreat":
      if (e.hp === 0) return; // dead, not retreating — "died"/hurt already tells the story
      return say(`🩹 ${who} retreating at ${e.hp}/${e.maxHp} HP`);
    case "resume":
      if (e.error || e.result === false) say(`⚠ ${who} could not resume goal ${JSON.stringify(e.goal ?? {})}`);
      return;
  }
}

// Board headings are tracked by content, not byte offset: edits above the end (like a pinned
// header) must not replay old posts.
let boardSeen = null;
function scanBoard() {
  if (!existsSync(BOARD)) return;
  const headings = readFileSync(BOARD, "utf8").split("\n").filter((l) => l.startsWith("## "));
  if (boardSeen) for (const h of headings) if (!boardSeen.has(h)) say(`📌 Board: ${h.slice(3, 180)}`);
  boardSeen = new Set(headings);
}

const lockSeen = new Map(); // file -> content
function scanLocks() {
  if (!existsSync(LOCKS)) return;
  for (const f of readdirSync(LOCKS).filter((f) => f.endsWith(".lock"))) {
    const text = readFileSync(join(LOCKS, f), "utf8").trim();
    const held = !/^RELEASED/.test(text);
    if (lockSeen.get(f) !== text && held) say(`🔒 ${f.replace(".lock", "")} claimed: ${text.slice(0, 140)}`);
    lockSeen.set(f, text);
    const age = Date.now() - statSync(join(LOCKS, f)).mtimeMs;
    const key = `stale:${f}:${text}`;
    if (held && age > STALE_LOCK_MS && !alerted.has(key)) {
      alerted.add(key);
      say(`⏳ stale lock ${f} held ${Math.round(age / 60000)} min: ${text.slice(0, 100)}`);
    }
  }
}

function tick() {
  for (const agent of existsSync(LOGS) ? readdirSync(LOGS) : []) {
    const file = join(LOGS, agent, "events.jsonl");
    for (const line of fresh(file)) {
      try {
        agentEvent(agent, JSON.parse(line));
      } catch {}
    }
    const since = offlineSince.get(agent);
    if (since && Date.now() - since > OFFLINE_ALERT_MS && !alerted.has(agent)) {
      alerted.add(agent);
      say(`🔴 ${agent} offline for ${Math.round((Date.now() - since) / 1000)} s`);
    }
  }
  scanBoard();
  for (const line of fresh(DEVWATCH))
    if (/restart|MISMATCH|did not become ready/.test(line)) say(`🛠 ${line.replace("[devwatch] ", "devwatch: ").slice(0, 180)}`);
  scanLocks();
}

// Asks (agent.requests): report new ones and status changes; asks to "main" are flagged for action.
const { memory } = await import("./memory.js");
const db = memory();
const askSeen = new Map(); // id -> status
let agentCharacters = new Set(); // lower-case character names of registered agents (refreshed with asks)
const refreshAgents = async () =>
  (agentCharacters = new Set((await db.sql`SELECT character FROM agent.agents`).map((r) => r.character.toLowerCase())));
await refreshAgents().catch(() => {});
let firstAsks = true;
async function scanAsks() {
  try {
    await refreshAgents();
    const rows = await db.sql`SELECT id, from_agent, to_agent, area, title, status FROM agent.requests
      WHERE updated_at > now() - interval '1 day' ORDER BY id`;
    for (const r of rows) {
      if (askSeen.get(r.id) === r.status) continue;
      if (!firstAsks || r.status === "open") {
        const flag = r.to_agent === "main" && r.status === "open" ? "📥 ASK FOR MAIN" : "📨 ask";
        say(`${flag} #${r.id} [${r.status}] ${r.from_agent} → ${r.to_agent} · ${r.area} · ${r.title.slice(0, 120)}`);
      }
      askSeen.set(r.id, r.status);
    }
    firstAsks = false;
    // Resumability: an agent whose body is online but whose mind hasn't checkpointed in 30+ min.
    const stale = await db.sql`SELECT a.name, max(c.created_at) AS last FROM agent.agents a
      LEFT JOIN agent.checkpoints c ON c.agent = a.name
      WHERE a.port IS NOT NULL AND coalesce(a.personality, '') NOT ILIKE 'Scripted%' GROUP BY a.name -- bots have no mind to resume
      HAVING max(c.created_at) IS NULL OR max(c.created_at) < now() - interval '30 minutes'`;
    for (const r of stale) {
      const key = `checkpoint:${r.name}:${r.last ?? "never"}`;
      if (offlineSince.has(r.name.toLowerCase()) || alerted.has(key)) continue;
      alerted.add(key);
      const age = r.last ? `${Math.round((Date.now() - new Date(r.last)) / 60000)} min` : "ever";
      say(`💾 ${r.name} has no checkpoint for ${age} (mailed them)`);
      // Remind the agent directly so main doesn't relay it by hand.
      await db.mail("main", r.name, "Checkpoint reminder (automatic)",
        `Your last resume checkpoint is ${age} old. Run: bun agent/resume.js save --name ${r.name} --summary "..." --tasks "a;b" --decisions "a;b"`);
    }
  } catch {}
}

say("orchestrator feed started");
tick();
setInterval(tick, 1000);
scanAsks();
setInterval(scanAsks, 10000);
