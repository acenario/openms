// Follow benchmark: a scripted leader walks a fixed multi-floor route; we score how closely the follower keeps up.
//   bun agent/followbench.js --follower Wayfinder [--leader Pacer] [--legs 6] [--leg-timeout 30]
// Both bodies must be on the same map. The route is the map's ropes/ladders (bottom, then top), so it crosses
// floors and exercises re-pathing. Prints one JSON line and appends a row to knowledge/Agents/<Follower>/FollowBench.md.
// The follower's previous goal is restored afterwards.
// ponytail: route = ladder ends (always standable); a hand-written route file is the upgrade for maps without ropes.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { memory } from "./memory.js";

const { values: o } = parseArgs({
  options: {
    follower: { type: "string" }, leader: { type: "string", default: "Pacer" },
    legs: { type: "string", default: "6" }, "leg-timeout": { type: "string", default: "30" },
    near: { type: "string", default: "150" }, "database-url": { type: "string" },
  },
  strict: true,
});
if (!o.follower) throw new Error("--follower required");
const NEAR = Number(o.near), LEGS = Number(o.legs), LEG_MS = Number(o["leg-timeout"]) * 1000;
const m = memory(o["database-url"]);
const ports = Object.fromEntries((await m.sql`SELECT name, port FROM agent.agents WHERE name IN (${o.follower}, ${o.leader})`).map((r) => [r.name, r.port]));
await m.close();
const api = (who) => `http://127.0.0.1:${ports[who]}`;
const get = (who, path) => fetch(api(who) + path, { signal: AbortSignal.timeout(3000) }).then((r) => r.json());
const post = (who, goal) => fetch(api(who) + "/goal", { method: "POST", body: JSON.stringify(goal) }).then((r) => r.json());

const [ls, fs] = [await get(o.leader, "/state"), await get(o.follower, "/state")];
if (ls.world?.mapId !== fs.world?.mapId) throw new Error(`not on the same map: ${o.leader} ${ls.world?.mapId}, ${o.follower} ${fs.world?.mapId}`);
const mapId = ls.world.mapId;
// A hurt body's survival planner rightly overrides follow/goto, so only measure healthy bodies.
for (const [who, s] of [[o.leader, ls], [o.follower, fs]])
  if (s.world.self.hp / s.world.self.maxHp < 0.7) throw new Error(`${who} is at ${s.world.self.hp}/${s.world.self.maxHp} HP — heal first (bench needs ≥70%)`);
// Shared danger zones (danger.json: {mapId: [{x1,x2,y1,y2,why}]}) — never route the bench through them.
const DANGER_FILE = join(import.meta.dir, "danger.json");
const danger = existsSync(DANGER_FILE) ? (JSON.parse(readFileSync(DANGER_FILE, "utf8"))[mapId] ?? []) : [];
const safe = (p) => !danger.some((z) => p.x >= z.x1 && p.x <= z.x2 && p.y >= z.y1 - 20 && p.y <= z.y2 + 20);
const ctx = await get(o.leader, "/context");
const route = (ctx.ladders ?? []).flatMap((l) => [{ x: l.x, y: l.bottom }, { x: l.x, y: l.top }]).filter(safe).slice(0, LEGS);
if (route.length < 2) throw new Error(`map ${mapId} has too few ropes/ladders for a route`);

const previous = fs.goal;
await post(o.follower, { type: "follow", name: o.leader });
const samples = [], legs = [];
const t0 = Date.now();
for (const wp of route) {
  await post(o.leader, { type: "goto", x: wp.x, y: wp.y });
  const start = Date.now();
  let arrived = null, caught = null;
  while (Date.now() - start < LEG_MS) {
    await Bun.sleep(250);
    const [l, f] = [await get(o.leader, "/state"), await get(o.follower, "/state")];
    const L = l.world?.self, F = f.world?.self;
    if (!L || !F || l.world.mapId !== f.world.mapId) { samples.push(Infinity); continue; }
    const d = Math.hypot(L.x - F.x, L.y - F.y);
    samples.push(d);
    if (!arrived && l.goal?.type === "idle") arrived = Date.now();
    if (arrived && d <= NEAR) { caught = Date.now(); break; }
  }
  legs.push({ to: wp, leaderMs: arrived ? arrived - start : null, catchUpMs: arrived && caught ? caught - arrived : null });
}
await post(o.follower, previous?.type && previous.type !== "follow" ? previous : { type: "idle" }).catch(() => {});

const finite = samples.filter(Number.isFinite).sort((a, b) => a - b);
const result = {
  at: new Date().toISOString().slice(0, 16) + "Z", follower: o.follower, leader: o.leader, mapId, legs: legs.length,
  nearPct: Math.round((100 * samples.filter((d) => d <= NEAR).length) / samples.length),
  medianPx: Math.round(finite[Math.floor(finite.length / 2)] ?? -1),
  maxPx: Math.round(finite.at(-1) ?? -1),
  caughtUp: legs.filter((l) => l.catchUpMs !== null).length,
  medianCatchUpMs: ((c) => c[Math.floor(c.length / 2)] ?? null)(legs.map((l) => l.catchUpMs).filter((x) => x !== null).sort((a, b) => a - b)),
  legDetail: legs.map((l) => `${l.leaderMs ?? "x"}/${l.catchUpMs ?? "x"}`).join(" "),
  version: fs.version, seconds: Math.round((Date.now() - t0) / 1000),
};
console.log(JSON.stringify(result));
const dir = join(import.meta.dir, "knowledge", "Agents", o.follower);
mkdirSync(dir, { recursive: true });
const file = join(dir, "FollowBench.md");
if (!existsSync(file))
  appendFileSync(file, `# ${o.follower} — follow benchmark\n\n\`bun agent/followbench.js --follower ${o.follower}\`: leader walks the map's rope ends; near = ≤${NEAR} px.\n\n| at | map | brain | near % | median px | max px | caught up | median catch-up ms | s |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- |\n`);
appendFileSync(file, `| ${result.at} | ${mapId} | ${result.version} | ${result.nearPct} | ${result.medianPx} | ${result.maxPx} | ${result.caughtUp}/${result.legs} | ${result.medianCatchUpMs ?? "–"} | ${result.seconds} |\n`);
