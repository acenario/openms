// Movement practice: run small courses N times against YOUR OWN running body and summarize how
// each behavior version does (success rate, time, stuck/jumps). Courses use the current map's
// ladders/exits from GET /context, so stand on a quiet map first (a town or a mob-free floor).
//   bun agent/drill.js --name Wayfinder --port 3311 --course climb --times 5
//   bun agent/drill.js --name Wayfinder --course all --times 3
//   bun agent/drill.js --name Wayfinder --summary          table from logs/<name>/drills.jsonl
// Courses:
//   climb        climb the nearest reachable ladder/rope, then drop back down (down+jump)
//   ladder-sides walk 60 px left of the ladder → climb, drop, walk 60 px right → climb, drop
//   drop         down+jump through the floor twice (the "drop 2 levels" course); success = y grew
//   portal       travel to the exit that is lowest relative to you, then travel back
// Every step is appended to logs/<name>/drills.jsonl with the body/brain version, so a behavior
// edit (hot-reloaded brain.js) can be compared with the run before it.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values: o } = parseArgs({
  options: {
    name: { type: "string" }, port: { type: "string", default: "3311" },
    course: { type: "string", default: "climb" }, times: { type: "string", default: "3" },
    summary: { type: "boolean", default: false },
  },
  strict: true,
});
if (!o.name) throw new Error("--name required (your own body only)");
if (o.port === "3310") throw new Error("3310 is Lumen's body; drill your own");
const DIR = join(import.meta.dir, "logs", o.name.toLowerCase());
const EPISODES = join(DIR, "episodes.jsonl");
const DRILLS = join(DIR, "drills.jsonl");
const api = `http://127.0.0.1:${o.port}`;
const get = async (p) => (await fetch(api + p)).json();
const post = async (g) => (await fetch(`${api}/goal`, { method: "POST", body: JSON.stringify(g) })).json();
const lineCount = () => (existsSync(EPISODES) ? readFileSync(EPISODES, "utf8").trim().split("\n").length : 0);
const me = async () => (await get("/state")).world?.self;

/** Post an episode goal and wait for its episodes.jsonl record. */
async function episode(g, timeoutMs = 70000) {
  const from = lineCount();
  const r = await post(g);
  if (!r.ok) return { outcome: "rejected", reason: r.error, durationMs: 0, metrics: {} };
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    await Bun.sleep(300);
    const rec = readFileSync(EPISODES, "utf8").trim().split("\n").slice(from).map((l) => JSON.parse(l))
      .find((e) => e.goal?.type === g.type);
    if (rec) return rec;
  }
  await post({ type: "stop" });
  return { outcome: "drill-timeout", durationMs: timeoutMs, metrics: {} };
}

/** Down+jump through the floor; not an episode, so judge by y after landing. */
async function drop() {
  const before = await me();
  const started = Date.now();
  await post({ type: "crouch", ms: 400 });
  await Bun.sleep(60);
  await post({ type: "jump" });
  await Bun.sleep(1500);
  const after = await me();
  const fell = after.y - before.y;
  return { outcome: fell > 20 ? "success" : "failed", reason: fell > 20 ? null : `y ${before.y}→${after.y}`, durationMs: Date.now() - started, metrics: { dy: fell } };
}

async function record(course, step, rec) {
  const { version } = await get("/state");
  const row = { course, step, version, outcome: rec.outcome, reason: rec.reason ?? null, durationMs: rec.durationMs, metrics: rec.metrics };
  appendFileSync(DRILLS, JSON.stringify({ t: new Date().toISOString(), ...row }) + "\n");
  console.log(`[drill] ${course}/${step} ${rec.outcome} ${(rec.durationMs / 1000).toFixed(1)}s ${rec.reason ?? ""}`);
}

const COURSES = {
  async climb() {
    await record("climb", "climb", await episode({ type: "climb" }));
    await record("climb", "drop", await drop());
  },
  async "ladder-sides"() {
    const ctx = await get("/context");
    const self = ctx.me;
    const ladder = ctx.ladders.filter((l) => self.y > l.top && self.y <= l.bottom + 90)
      .sort((a, b) => Math.abs(a.x - self.x) - Math.abs(b.x - self.x))[0];
    if (!ladder) return record("ladder-sides", "find", { outcome: "skipped", reason: "no reachable ladder", durationMs: 0 });
    for (const [side, dx] of [["left", -60], ["right", 60]]) {
      await record("ladder-sides", `goto-${side}`, await episode({ type: "goto", x: ladder.x + dx }, 35000));
      await record("ladder-sides", `climb-from-${side}`, await episode({ type: "climb" }));
      await record("ladder-sides", `drop-${side}`, await drop());
    }
  },
  async drop() {
    await record("drop", "drop-1", await drop());
    await record("drop", "drop-2", await drop());
  },
  async portal() {
    const ctx = await get("/context");
    const home = Number(ctx.map.match(/\((\d+)\)$/)[1]);
    const exit = [...ctx.exits].sort((a, b) => b.dy - a.dy)[0];
    if (!exit) return record("portal", "find", { outcome: "skipped", reason: "no exits", durationMs: 0 });
    await record("portal", `out-${exit.name}(dy ${exit.dy})`, await episode({ type: "travel", map: exit.to }));
    await record("portal", "back", await episode({ type: "travel", map: home }));
  },
};

function summary() {
  if (!existsSync(DRILLS)) return console.log("no drills yet");
  const groups = new Map();
  for (const r of readFileSync(DRILLS, "utf8").trim().split("\n").map((l) => JSON.parse(l))) {
    const key = `${r.course}/${r.step.replace(/\(.*\)/, "")} @${r.version}`;
    const g = groups.get(key) ?? { n: 0, ok: 0, ms: 0, stuck: 0, jumps: 0 };
    g.n++; g.ok += r.outcome === "success"; g.ms += r.durationMs; g.stuck += r.metrics?.stuck ?? 0; g.jumps += r.metrics?.jumps ?? 0;
    groups.set(key, g);
  }
  console.log("course/step @version                     ok/n   avg s  stuck/run  jumps/run");
  for (const [k, g] of groups)
    console.log(`${k.padEnd(41)} ${`${g.ok}/${g.n}`.padStart(5)} ${(g.ms / g.n / 1000).toFixed(1).padStart(7)} ${(g.stuck / g.n).toFixed(1).padStart(10)} ${(g.jumps / g.n).toFixed(1).padStart(10)}`);
}

if (o.summary) summary();
else {
  const names = o.course === "all" ? Object.keys(COURSES) : o.course.split(",");
  for (const n of names) if (!COURSES[n]) throw new Error(`unknown course ${n}; have ${Object.keys(COURSES).join(", ")}`);
  for (let i = 0; i < Number(o.times); i++) for (const n of names) await COURSES[n]();
  summary();
}
