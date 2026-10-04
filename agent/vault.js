// Build an Obsidian vault of world knowledge from the game's own generated data — no model.
//   bun agent/vault.js [--game http://127.0.0.1:3102] [--out agent/knowledge]
// Notes link with [[wikilinks]] so Obsidian's graph view shows maps ↔ NPCs ↔ quests ↔ mobs ↔ items.
// Generated notes live under World/ and are overwritten on every run; agents write their own
// experience under Learned/ (never touched here).
// ponytail: reads every map manifest once (cached in .cache/); ~3 GB first run, seconds after.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values: opts } = parseArgs({
  options: {
    game: { type: "string", default: "http://127.0.0.1:3102" },
    out: { type: "string", default: join(import.meta.dir, "knowledge") },
    concurrency: { type: "string", default: "6" },
  },
  strict: true,
});
const ORIGIN = new URL(opts.game).origin;
const OUT = opts.out;
const WORLD = join(OUT, "World");
const CACHE = join(OUT, ".cache");
const c = await (await fetch(`${ORIGIN}/generated/catalog.json`)).json();

// ---------- names & links ----------
const safe = (s) => String(s).replace(/[\\/:*?"<>|#^[\]]/g, "").replace(/\s+/g, " ").trim();
const mapName = (id) => c.mapNames[Number(id)] ?? `Map ${Number(id)}`;
const mapNote = (id) => `${safe(mapName(id))} (${Number(id)})`;
const npcName = (id) => c.quests.strings.npc?.[String(Number(id))] ?? `NPC ${Number(id)}`;
const npcNote = (id) => `${safe(npcName(id))} (NPC ${Number(id)})`;
const mobName = (id) => c.monsters[String(Number(id))]?.name ?? c.quests.strings.mob?.[String(Number(id))] ?? `Mob ${Number(id)}`;
const mobNote = (id) => `${safe(mobName(id))} (Mob ${Number(id)})`;
const itemName = (id) => c.ui.items[String(Number(id))]?.name?.trim() ?? c.quests.strings.item?.[String(Number(id))] ?? `Item ${Number(id)}`;
const itemNote = (id) => `${safe(itemName(id))} (Item ${Number(id)})`;
const quest = (id) => c.quests.records[String(id)];
const questNote = (id) => `${safe(quest(id)?.name || `Quest ${id}`)} (Quest ${id})`;
const link = (note) => `[[${note}]]`;

/** MapleStory markup → readable Markdown (names resolved, choices as list items). */
const prose = (text) =>
  String(text ?? "")
    .replace(/\\r\\n|\r\n|\\n/g, "\n")
    .replace(/#L(\d+)#/g, "\n- ($1) ")
    .replace(/#l/g, "")
    .replace(/#h(?:0| )?#/g, "<you>")
    .replace(/#[pP](\d+):?#/g, (_, id) => npcName(id))
    .replace(/#[oO](\d+):?#/g, (_, id) => mobName(id))
    .replace(/#[tTzZ](\d+):?#/g, (_, id) => itemName(id))
    .replace(/#[iI](\d+):?#/g, "")
    .replace(/#[mM](\d+):?#/g, (_, id) => mapName(id))
    .replace(/#[bk]/g, "**")
    .replace(/#[grdne]/g, "")
    .replace(/#[fF][^#\n]+#/g, "")
    .replace(/#@\d+:#|#[cvauy]\d+:?#/g, "")
    .replace(/\*\*\s*\*\*/g, "")
    .trim();

// ---------- per-map facts (cached manifest digests) ----------
mkdirSync(CACHE, { recursive: true });
async function digest(id) {
  const file = join(CACHE, `${id}.json`);
  const descriptor = c.maps[id];
  if (existsSync(file)) {
    const cached = JSON.parse(readFileSync(file, "utf8"));
    if (cached.sha256 === descriptor.sha256) return cached;
  }
  const m = await (await fetch(new URL(descriptor.url, ORIGIN))).json();
  const npcs = [], mobs = {};
  for (const p of m.life?.placements ?? []) {
    const t = m.life.templates[p.template];
    if (p.kind === "npc") npcs.push({ id: Number(t.originalId), x: p.authored.x, y: p.authored.cy ?? p.authored.y });
    else if (t?.originalId) mobs[Number(t.originalId)] = (mobs[Number(t.originalId)] ?? 0) + 1;
  }
  const out = {
    sha256: descriptor.sha256,
    exits: m.physics.portals.filter((p) => p.targetMap && p.targetMap !== 999999999).map((p) => ({ name: p.name, x: p.x, y: p.y, to: p.targetMap })),
    npcs,
    mobs,
    ladders: m.physics.ladders.length,
    bounds: m.bounds,
  };
  writeFileSync(file, JSON.stringify(out));
  return out;
}
const ids = Object.keys(c.maps);
const facts = {};
for (let i = 0; i < ids.length; i += Number(opts.concurrency)) {
  const batch = ids.slice(i, i + Number(opts.concurrency));
  await Promise.all(batch.map(async (id) => (facts[id] = await digest(id).catch((e) => ({ error: e.message, exits: [], npcs: [], mobs: {} })))));
  if (i % 60 === 0) process.stdout.write(`\r[vault] maps ${Math.min(i + batch.length, ids.length)}/${ids.length}`);
}
console.log();

// ---------- indexes ----------
const npcMaps = {}, mobMaps = {}, questsByNpc = {}, itemUses = {};
for (const [id, f] of Object.entries(facts)) {
  for (const n of f.npcs) (npcMaps[n.id] ??= new Set()).add(id);
  for (const [mob, count] of Object.entries(f.mobs)) (mobMaps[mob] ??= new Map()).set(id, count);
}
for (const [mob, list] of Object.entries(c.spawns.mobs ?? {}))
  for (const s of list) (mobMaps[mob] ??= new Map()).set(s.mapId, Math.max(s.count, mobMaps[mob].get(s.mapId) ?? 0));
const questIds = Object.keys(c.quests.records).filter((id) => quest(id)?.name);
for (const id of questIds) {
  const [start, end] = quest(id).stages ?? [];
  if (start?.check?.npc) (questsByNpc[start.check.npc] ??= { starts: [], ends: [] }).starts.push(id);
  if (end?.check?.npc) (questsByNpc[end.check.npc] ??= { starts: [], ends: [] }).ends.push(id);
  for (const it of [...(end?.check?.items ?? []), ...(end?.act?.items ?? [])]) (itemUses[it.id] ??= new Set()).add(id);
}

// ---------- write notes ----------
rmSync(WORLD, { recursive: true, force: true });
const write = (dir, note, body) => {
  mkdirSync(join(WORLD, dir), { recursive: true });
  writeFileSync(join(WORLD, dir, `${note}.md`), body);
};
const fm = (o) => `---\n${Object.entries(o).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join("\n")}\n---\n`;
const levelRange = (s) => (s?.check?.lvmin || s?.check?.lvmax ? `${s.check.lvmin ?? 1}–${s.check.lvmax ?? "∞"}` : "any");

let counts = { maps: 0, npcs: 0, quests: 0, mobs: 0, items: 0 };
for (const [id, f] of Object.entries(facts)) {
  const exits = [...new Map(f.exits.map((e) => [e.to, e])).values()];
  write("Maps", mapNote(id), `${fm({ type: "map", id: Number(id), name: mapName(id), tags: ["map"] })}
# ${mapName(id)}

**Map id:** ${Number(id)}${f.ladders ? ` · **Ladders/ropes:** ${f.ladders}` : ""}

## Exits
${exits.map((e) => `- ${link(mapNote(e.to))} — portal \`${e.name}\` at x=${e.x}, y=${e.y}`).join("\n") || "- none (dead end or scripted)"}

## NPCs
${f.npcs.map((n) => `- ${link(npcNote(n.id))} at x=${n.x}, y=${n.y}`).join("\n") || "- none"}

## Monsters
${Object.entries(f.mobs).map(([m, n]) => `- ${link(mobNote(m))} ×${n}`).join("\n") || "- none"}
`);
  counts.maps++;
}

for (const [npc, maps] of Object.entries(npcMaps)) {
  const q = questsByNpc[npc] ?? { starts: [], ends: [] };
  write("NPCs", npcNote(npc), `${fm({ type: "npc", id: Number(npc), name: npcName(npc), tags: ["npc"] })}
# ${npcName(npc)}

## Found in
${[...maps].map((m) => `- ${link(mapNote(m))}`).join("\n")}

## Gives quests
${q.starts.map((id) => `- ${link(questNote(id))} (level ${levelRange(quest(id).stages[0])})`).join("\n") || "- none"}

## Completes quests
${q.ends.map((id) => `- ${link(questNote(id))}`).join("\n") || "- none"}
`);
  counts.npcs++;
}

for (const id of questIds) {
  const r = quest(id);
  const [start, end] = r.stages ?? [];
  const pages = (s) => (s?.say?.pages ?? []).map((p) => prose(p.text)).filter(Boolean);
  const needs = [
    ...(end?.check?.mobs ?? []).map((m) => `- Hunt ${link(mobNote(m.id))} ×${m.count}`),
    ...(end?.check?.items ?? []).filter((i) => i.count > 0).map((i) => `- Bring ${link(itemNote(i.id))} ×${i.count}`),
  ];
  const rewards = [
    end?.act?.exp ? `- ${end.act.exp} EXP` : null,
    end?.act?.money ? `- ${end.act.money} mesos` : null,
    ...(end?.act?.items ?? []).filter((i) => i.count > 0).map((i) => `- ${link(itemNote(i.id))} ×${i.count}`),
    end?.act?.nextQuest ? `- unlocks ${link(questNote(end.act.nextQuest))}` : null,
  ].filter(Boolean);
  write("Quests", questNote(id), `${fm({ type: "quest", id: Number(id), name: r.name, levels: levelRange(start), supported: r.supported ?? null, tags: ["quest"] })}
# ${r.name}

**Starts with:** ${start?.check?.npc ? link(npcNote(start.check.npc)) : "auto/unknown"} · **Ends with:** ${end?.check?.npc ? link(npcNote(end.check.npc)) : "unknown"} · **Level:** ${levelRange(start)}${start?.check?.jobs?.length ? ` · **Jobs:** ${start.check.jobs.join(", ")}` : ""}
${(start?.check?.quests ?? []).length ? `\n**Requires quests:** ${start.check.quests.map((q) => link(questNote(q.id))).join(", ")}\n` : ""}
## To complete
${needs.join("\n") || "- talk to the end NPC"}

## Rewards
${rewards.join("\n") || "- none recorded"}

## Summary
${Object.values(r.info ?? {}).map(prose).filter(Boolean).map((t) => `> ${t}`).join("\n>\n") || "—"}

## Dialogue (start)
${pages(start).join("\n\n---\n\n") || "—"}

## Dialogue (end)
${pages(end).join("\n\n---\n\n") || "—"}
`);
  counts.quests++;
}

for (const [mob, maps] of Object.entries(mobMaps)) {
  write("Mobs", mobNote(mob), `${fm({ type: "mob", id: Number(mob), name: mobName(mob), tags: ["mob"] })}
# ${mobName(mob)}

## Found in
${[...maps].map(([m, n]) => `- ${link(mapNote(m))} ×${n}`).join("\n")}
`);
  counts.mobs++;
}

for (const [item, qs] of Object.entries(itemUses)) {
  write("Items", itemNote(item), `${fm({ type: "item", id: Number(item), name: itemName(item), tags: ["item"] })}
# ${itemName(item)}

## Used in quests
${[...qs].map((q) => `- ${link(questNote(q))}`).join("\n")}
`);
  counts.items++;
}

mkdirSync(join(OUT, "Learned"), { recursive: true });
writeFileSync(join(OUT, "Home.md"), `# OpenMS world knowledge

Generated from the game's own data by \`agent/vault.js\` (no model involved) — rerun after re-extraction.
Open this folder as an Obsidian vault; the graph view links maps, NPCs, quests, mobs and items.

- **World/** — generated facts: ${counts.maps} maps, ${counts.npcs} NPCs, ${counts.quests} quests, ${counts.mobs} monsters, ${counts.items} quest items. Overwritten on every run.
- **Learned/** — notes agents write from experience (link them to World notes with [[wikilinks]]). Never overwritten.

Start: ${link(mapNote("000010000"))}
`);
console.log("[vault]", counts, "→", OUT);
process.exit(0);
