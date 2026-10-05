// Standing order: keep hunting until a target level, spending AP as you go, using the /wait play
// loop (no /state polling). Re-issues the hunt whenever it ends (success, retreat-and-idle, no mobs),
// waits out retreats, and stops at the level, a time budget, or too many failures in a row.
//   bun agent/grind.js --port 3311 --to-level 7 --map 1010000 --stat str --skill 1000 --minutes 30 [--mob "Shroom,Blue Snail"]
// --cast <skillId>: attack with this skill instead of basic swings (e.g. 1000 Three Snails).
// --keep <mesos>: never spend below this when restocking (e.g. 150 for the boat).
// --map: travel back there whenever we are elsewhere (e.g. revived in town after dying).
// Low HP with no reachable rope: stop and stand still, so vitals casts Recovery on the floor.
// Prints one line per goal-done / level-up so the LLM can read the whole session at the end.
import { parseArgs } from "node:util";

const { values: o } = parseArgs({
  options: {
    name: { type: "string" }, port: { type: "string", default: "3311" }, "to-level": { type: "string" }, mob: { type: "string" },
    stat: { type: "string" }, skill: { type: "string" }, cast: { type: "string" }, keep: { type: "string" }, map: { type: "string" }, minutes: { type: "string", default: "30" }, limit: { type: "string", default: "40" },
  },
  strict: true,
});
if (o.port === "3310" && o.name !== "Lumen") throw new Error("3310 is Lumen's body; pass --name Lumen");
const api = `http://127.0.0.1:${o.port}`;
/** fetch JSON, riding out body restarts (run.js restarts it in ~3 s on code changes). */
async function call(path, init) {
  for (let i = 0; ; i++) {
    try { return await (await fetch(api + path, init)).json(); }
    catch (e) { if (i >= 20) throw e; await Bun.sleep(1500); }
  }
}
const post = (g) => call("/goal", { method: "POST", body: JSON.stringify(g) });
const state = () => call("/state");
const until = Date.now() + Number(o.minutes) * 60000;
const target = Number(o["to-level"]);
const hunt = { type: "hunt", limit: Number(o.limit), ...(o.cast ? { skill: Number(o.cast) } : {}), ...(o.keep ? { keep: Number(o.keep) } : {}), ...(o.mob ? { mob: o.mob.split(",").map((s) => s.trim()) } : {}) };
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function spendAp() {
  const s = await state();
  const ap = s.world?.self?.ap ?? 0;
  if (o.stat && ap > 0) log("AP", ap, "→", o.stat, (await post({ type: "command", action: { kind: "stats.allocate", stat: o.stat, amount: ap } })).result);
  // --skill: put free beginner skill points into this skill (e.g. 1000 Three Snails), as far as the server allows.
  const sp = o.skill ? (await call("/character")).beginnerSkillPoints ?? 0 : 0;
  if (sp > 0) log("SP", sp, "→ skill", o.skill, (await post({ type: "command", action: { kind: "skills.allocate", skillId: Number(o.skill), amount: sp } })).result);
  return s.world?.self;
}

let fails = 0;
let since = (await call("/wait?since=999999999&timeout=0")).seq;
let me = await spendAp();
const s0 = await state();
// Elsewhere (e.g. just off the boat in town): travel first; the loop re-hunts on arrival (a town hunt ends "no mobs here").
if (o.map && s0.world?.mapId !== Number(o.map)) log("to map", o.map, (await post({ type: "travel", map: Number(o.map) })).ok);
else if (s0.goal?.type !== "hunt") log("start", JSON.stringify(await post(hunt)));
while (Date.now() < until && !(target && me?.level >= target)) {
  const r = await call(`/wait?since=${since}&timeout=60&kinds=goal-done,level-up,resume,offline,online`);
  if (r.seq < since) since = 0; // body restarted: its event sequence starts over
  since = Math.max(since, r.seq);
  for (const e of r.events) {
    if (e.kind === "level-up") (log("LEVEL", e.level), (me = await spendAp()));
    if (e.kind !== "goal-done") continue;
    log(e.goal?.type, e.outcome, e.reason ?? "", `kills ${e.metrics?.kills ?? 0} exp+${e.metrics?.expGained ?? 0} hpLost ${e.metrics?.hpLost ?? 0}`);
    fails = e.outcome === "failed" ? fails + 1 : 0;
  }
  if (fails >= 3) { log("stopping: 3 failures in a row"); break; }
  const s = await state();
  me = s.world?.self ?? me;
  if (s.online && s.goal?.type === "perch" && !s.goal.resumeAfter && me?.hp >= me.maxHp * 0.9) log("healed: re-hunt", (await post(hunt)).ok);
  if (!s.online || s.goal?.type !== "idle") continue;
  // hunt refuses to start below 30% HP ("stopped: low HP"): heal on a rope first instead of re-hunting in a tight loop.
  if (o.map && s.world?.mapId !== Number(o.map)) log("back to map", o.map, (await post({ type: "travel", map: Number(o.map) })).ok);
  else if (me && me.hp < me.maxHp * 0.5) {
    const r = await post({ type: "perch" });
    log("heal first:", r.ok ? "perch" : `stand still (${r.error})`, `HP ${me.hp}/${me.maxHp}`);
    if (!r.ok) await Bun.sleep(8000); // idle on the floor; vitals casts Recovery
  } else log("re-hunt", (await post(hunt)).ok);
  await Bun.sleep(1000);
}
log("done: level", me?.level, "exp", me?.exp);
await post({ type: "perch" }).catch(() => {});
