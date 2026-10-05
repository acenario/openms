// Who drops what, from the server's own drop tables in the generated catalog (drops.mobs /
// drops.reactors). The vault has no drop data, so "where do I get Rusty Screw?" had no answer.
//   bun agent/drops.js --item "Rusty Screw"      mobs + reactors (boxes) that drop it, and where
//   bun agent/drops.js --item 4031161
//   bun agent/drops.js --mob 100101              one monster's drop table
// Chance is per kill/break. Quest-only rows ("quest 1008") drop only while that quest is active.
// Reactor locations come from scanning map manifests (slow-ish: ~700 maps), so only with --item.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values: o } = parseArgs({
  options: { game: { type: "string", default: "http://127.0.0.1:3102" }, item: { type: "string" }, mob: { type: "string" } },
  strict: true,
});
const origin = new URL(o.game).origin;
const c = await (await fetch(`${origin}/generated/catalog.json`)).json();
const D = c.drops;
const itemName = (id) => Number(id) === 0 ? "mesos" : c.ui.items[String(id)]?.name?.trim() ?? `item ${id}`;
const mobName = (id) => c.quests.strings.mob?.[String(id)] ?? `mob ${id}`;
const pct = (chance, scale) => `${((100 * chance) / scale).toPrecision(2)}%`;
const quest = (r) => (r.questId ? ` (only during quest ${r.questId} ${c.quests.records[String(r.questId)]?.name ?? ""})` : "");

if (o.mob) {
  const rows = D.mobs[String(o.mob)]?.rows ?? [];
  console.log(`${mobName(o.mob)} (${o.mob}) — ${rows.length} drop rows`);
  for (const r of rows.sort((a, b) => b.chance - a.chance))
    console.log(`  ${pct(r.chance, 1e6).padStart(7)}  ${itemName(r.itemId)} (${r.itemId})${r.maximum > 1 ? ` ×${r.minimum}-${r.maximum}` : ""}${quest(r)}${r.status !== "supported" ? ` [${r.status}]` : ""}`);
}

if (o.item) {
  const want = /^\d+$/.test(o.item) ? [Number(o.item)]
    : Object.entries(c.ui.items).filter(([, v]) => v?.name?.trim().toLowerCase() === o.item.toLowerCase()).map(([k]) => Number(k));
  if (!want.length) throw new Error(`no item named ${o.item}`);
  for (const id of want) {
    console.log(`${itemName(id)} (${id})`);
    const mobs = Object.entries(D.mobs).flatMap(([mob, v]) => v.rows.filter((r) => r.itemId === id).map((r) => ({ mob, r })));
    for (const { mob, r } of mobs.sort((a, b) => b.r.chance - a.r.chance)) {
      const where = await (async () => {
        const dir = join(import.meta.dir, "knowledge", "World", "Mobs");
        const f = readdirSync(dir).find((n) => n.endsWith(`(Mob ${mob}).md`));
        if (!f) return "";
        const text = await Bun.file(join(dir, f)).text();
        return [...text.matchAll(/^- \[\[([^\]]+)\]\]/gm)].slice(0, 4).map((m) => m[1]).join("; ");
      })();
      console.log(`  mob ${mobName(mob)} (${mob}) ${pct(r.chance, 1e6)}${quest(r)}${where ? ` — e.g. ${where}` : ""}`);
    }
    const reactors = Object.entries(D.reactors.rows).filter(([, rows]) => rows.some((r) => r.itemId === id));
    if (!reactors.length) continue;
    const ids = new Set(reactors.map(([rid]) => rid.padStart(7, "0")));
    const found = new Map();
    for (const [key, desc] of Object.entries(c.maps)) {
      const m = await (await fetch(new URL(desc.url, origin))).json().catch(() => null);
      for (const p of m?.reactors?.placements ?? []) if (ids.has(p.templateId)) found.set(`${c.mapNames[Number(key)] ?? key} (${Number(key)})`, (found.get(`${c.mapNames[Number(key)] ?? key} (${Number(key)})`) ?? 0) + 1);
    }
    for (const [rid, rows] of reactors) {
      const r = rows.find((x) => x.itemId === id);
      const total = rows.reduce((n, x) => n + x.chance, 0);
      console.log(`  box/reactor ${rid}: ${r.chance}/${total} of its drop rolls${quest(r)}`);
    }
    for (const [map, n] of found) console.log(`    placed in ${map} ×${n}`);
  }
}
