// Combat benchmark: hunt for a fixed window on a fixed map and measure efficiency and safety.
//   bun agent/huntbench.js --name Wayfinder [--map 1010000] [--seconds 300] [--mobs "Red Snail,Blue Snail"] [--skill 1000]
// Metrics: EXP/min, kills/min, damage taken/min (from HP samples), potions per kill, deaths, survival decisions,
// share of time with no target. The agent's previous goal is restored afterwards. Appends a row to
// knowledge/Agents/<Name>/HuntBench.md; prints one JSON line.
// ponytail: EXP across a level-up uses next = 15·level² (client offline-progression, server agrees for 1–10); a
// table lookup is the upgrade once agents level past where that formula was checked.
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { memory } from "./memory.js";

const { values: o } = parseArgs({
  options: {
    name: { type: "string" }, map: { type: "string" }, seconds: { type: "string", default: "300" },
    mobs: { type: "string" }, skill: { type: "string" }, "database-url": { type: "string" },
  },
  strict: true,
});
if (!o.name) throw new Error("--name required");
const m = memory(o["database-url"]);
const [row] = await m.sql`SELECT port FROM agent.agents WHERE name = ${o.name}`;
await m.close();
const api = `http://127.0.0.1:${row.port}`;
const get = (p) => fetch(api + p, { signal: AbortSignal.timeout(3000) }).then((r) => r.json());
const post = (goal) => fetch(api + "/goal", { method: "POST", body: JSON.stringify(goal) }).then((r) => r.json());
const next = (level) => 15 * level * level;

let s = await get("/state");
const previous = s.goal;
if (o.map && s.world.mapId !== Number(o.map)) {
  await post({ type: "travel", map: Number(o.map) });
  const until = Date.now() + 180000;
  while ((s = await get("/state")).world?.mapId !== Number(o.map)) {
    if (Date.now() > until) throw new Error(`could not reach map ${o.map}`);
    await Bun.sleep(2000);
  }
}
if (s.world.self.hp / s.world.self.maxHp < 0.7) throw new Error(`${o.name} at ${s.world.self.hp}/${s.world.self.maxHp} HP — heal first (bench needs ≥70%)`);

const hunt = { type: "hunt", limit: 9999, ...(o.mobs ? { mobs: o.mobs } : {}), ...(o.skill ? { skill: Number(o.skill) } : {}) };
const { seq: seq0 } = await get("/events?kinds=*&since=999999999");
await post(hunt);
const t0 = Date.now(), end = t0 + Number(o.seconds) * 1000;
let exp = 0, damage = 0, kills = 0, noTarget = 0, samples = 0, lastKills = 0, attacks = 0, lastAttacks = 0;
let prev = s.world.self;
while (Date.now() < end) {
  await Bun.sleep(1000);
  const st = await get("/state").catch(() => null);
  const me = st?.world?.self;
  if (!me) continue;
  samples++;
  exp += me.level > prev.level ? next(prev.level) - prev.exp + me.exp : Math.max(0, me.exp - prev.exp);
  if (me.hp < prev.hp && me.hp > 0) damage += prev.hp - me.hp;
  const k = st.episode?.type === "hunt" ? st.episode.metrics?.kills ?? 0 : 0;
  kills += k >= lastKills ? k - lastKills : k; // a resumed/paused goal restarts its counter
  lastKills = k;
  const a = st.episode?.type === "hunt" ? st.episode.metrics?.attacks ?? 0 : 0;
  attacks += a >= lastAttacks ? a - lastAttacks : a;
  lastAttacks = a;
  if (st.goal?.type === "hunt" && !st.goal.targetId) noTarget++;
  prev = me;
}
const { events } = await get(`/events?kinds=*&since=${seq0}`);
await post(previous?.type && previous.type !== "hunt" ? previous : hunt).catch(() => {});

const minutes = (Date.now() - t0) / 60000;
const count = (pred) => events.filter(pred).length;
const potions = count((e) => e.kind === "reflex" && /potion/i.test(e.action ?? ""));
const survive = {};
for (const e of events.filter((e) => e.kind === "survive" && !e.outcome)) survive[e.option] = (survive[e.option] ?? 0) + 1;
const result = {
  at: new Date().toISOString().slice(0, 16) + "Z", name: o.name, mapId: s.world.mapId, level: prev.level, version: s.version,
  minutes: Math.round(minutes * 10) / 10,
  expPerMin: Math.round(exp / minutes), killsPerMin: Math.round((kills / minutes) * 10) / 10,
  damagePerMin: Math.round(damage / minutes), potionsPerKill: kills ? Math.round((potions / kills) * 100) / 100 : null,
  attacksPerKill: kills ? Math.round((attacks / kills) * 10) / 10 : null,
  deaths: count((e) => e.kind === "died"), noTargetPct: samples ? Math.round((100 * noTarget) / samples) : null,
  survive,
};
console.log(JSON.stringify(result));
const dir = join(import.meta.dir, "knowledge", "Agents", o.name);
mkdirSync(dir, { recursive: true });
const file = join(dir, "HuntBench.md");
if (!existsSync(file))
  appendFileSync(file, `# ${o.name} — hunt benchmark\n\n\`bun agent/huntbench.js --name ${o.name} --map <id> --seconds 300\`. Higher EXP/min and kills/min, lower damage/min, potions/kill and no-target % are better; deaths must be 0.\n\n| at | map | lvl | brain | min | EXP/min | kills/min | dmg/min | swings/kill | potions/kill | deaths | no target % | survival choices |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |\n`);
appendFileSync(file, `| ${result.at} | ${result.mapId} | ${result.level} | ${result.version} | ${result.minutes} | ${result.expPerMin} | ${result.killsPerMin} | ${result.damagePerMin} | ${result.attacksPerKill ?? "–"} | ${result.potionsPerKill ?? "–"} | ${result.deaths} | ${result.noTargetPct} | ${Object.entries(survive).map(([k, v]) => `${k}×${v}`).join(" ") || "–"} |\n`);
