// Quest log + progression for a character, straight from the server's Postgres (no body/endpoint
// needed) joined with the game catalog. Shows active quests with objective progress and where to
// hand them in, what you finished, and what is offered next along a route of maps.
//   bun agent/questlog.js --name Wayfinder
//   bun agent/questlog.js --name Lumen --route 1000000,1010000,2000000,104000000,101000000
// The DB copy is the server's last checkpoint, so it can trail live play by a little.
// Kill counts come from profile.quests[id].kills; item counts from item_instance.
import { SQL } from "bun";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { questBook } from "./quests.js";

const { values: o } = parseArgs({
  options: {
    name: { type: "string" },
    game: { type: "string", default: "http://127.0.0.1:3102" },
    database: { type: "string", default: "postgres://openms:openms_local_only@127.0.0.1:55432/openms" },
    // Maple Island → Southperry → Lith Harbor → Ellinia (the beginner's path)
    route: { type: "string", default: "10000,20000,30000,40000,50000,1000000,1010000,1020000,2000000,104000000,101000000" },
  },
  strict: true,
});
if (!o.name) throw new Error("--name required");

const db = new SQL(o.database);
const [row] = await db`select id, map_id, updated_at, profile from character where profile->>'name' = ${o.name} and deleted_at is null`;
if (!row) throw new Error(`no character named ${o.name}`);
const items = await db`select template_id, sum(quantity)::int as n from item_instance where owner_id = ${row.id} group by template_id`;
await db.close();

const book = await questBook(o.game);
const p = row.profile;
const have = new Map(items.map((i) => [i.template_id, i.n]));
const quests = p.quests ?? {};
const state = (id) => quests[String(id)]?.state ?? 0;

// NPC → map, from the vault's NPC notes ("Found in" first link).
const NPC_DIR = join(import.meta.dir, "knowledge", "World", "NPCs");
const npcHome = new Map();
for (const f of readdirSync(NPC_DIR)) {
  const id = f.match(/\(NPC (\d+)\)\.md$/)?.[1];
  const home = readFileSync(join(NPC_DIR, f), "utf8").match(/## Found in\n- \[\[([^\]]+)\]\]/)?.[1];
  if (id && home) npcHome.set(Number(id), home);
}
const where = (npc) => `${book.npcName(npc)}${npcHome.has(npc) ? ` @ ${npcHome.get(npc)}` : ""}`;

console.log(`${o.name} · level ${p.level} · exp ${p.exp} · ${book.mapName(row.map_id)} (${row.map_id}) · AP ${p.remainingAp ?? 0} · checkpoint ${row.updated_at.toISOString()}`);

console.log("\nACTIVE");
const active = Object.entries(quests).filter(([, q]) => q.state === 1);
if (!active.length) console.log("  (none)");
for (const [id, q] of active) {
  const rec = book.records[id];
  if (!rec) { console.log(`  ${id} (not in catalog)`); continue; }
  const parts = book.objectives(rec).map((ob) => {
    const n = ob.kind === "kill" ? Number(q.kills?.[ob.id] ?? q.kills?.[String(ob.id)] ?? 0) : have.get(ob.id) ?? 0;
    return `${ob.kind} ${ob.name} ${Math.min(n, ob.count)}/${ob.count}${n >= ob.count ? " ✓" : ""}`;
  });
  const done = book.objectives(rec).every((ob) => (ob.kind === "kill" ? Number(q.kills?.[ob.id] ?? 0) : have.get(ob.id) ?? 0) >= ob.count);
  console.log(`  ${id} ${rec.name}${done ? "  — READY to hand in" : ""}`);
  console.log(`     ${parts.join(" · ") || "talk to the end NPC"} → ${where(rec.stages[1]?.check?.npc ?? rec.stages[0].check.npc)}`);
}

const completed = Object.entries(quests).filter(([, q]) => q.state === 2).map(([id]) => `${id} ${book.qName(id)}`);
console.log(`\nCOMPLETED (${completed.length})\n  ${completed.join("\n  ") || "(none)"}`);

console.log("\nOFFERED NEXT ON THE ROUTE (server-supported, level fits, prerequisites done)");
const seen = new Set();
for (const mapId of o.route.split(",").map(Number)) {
  let npcs;
  try { npcs = await book.npcsOn(mapId); } catch { continue; }
  for (const npc of npcs) for (const rec of book.forNpc(npc)) {
    if (seen.has(rec.id) || rec.stages[0].check.npc !== npc || state(rec.id) !== 0) continue;
    if (book.verdict(rec, p.level) !== "OK") continue;
    if (!rec.stages[0].check.quests.every((pre) => state(pre.id) === (pre.state ?? 2))) continue;
    seen.add(rec.id);
    console.log(book.describe(rec, p.level).split("\n").map((l) => "  " + l).join("\n") + `\n     at ${book.mapName(mapId)} (${mapId})`);
  }
}
