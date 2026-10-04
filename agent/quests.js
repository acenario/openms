// Which quests can an NPC actually give on THIS server? The vault lists every quest in the data,
// but many are dead here: unsupported (blockers) or gated on owning a GM-only item.
//   bun agent/quests.js --npc 2005            quests NPC 2005 starts/ends, with verdicts
//   bun agent/quests.js --map 50000           same, for every NPC on a map
//   bun agent/quests.js --quest 1037          one quest in detail
//   bun agent/quests.js --map 50000 --level 3 only quests startable at level 3
// Verdicts: OK | UNSUPPORTED (server refuses; npc.open is a silent no-op) | GATED (needs an item
// nobody can get, e.g. Wizet Plain Suit 1042003) | UNREACHABLE (a prerequisite quest is dead) |
// LEVEL (outside the level range). OK means "the server will offer it", not "worth it".
// Also a module: `questBook(game)` is used by questlog.js.
import { parseArgs } from "node:util";

const GM_ITEMS = new Set([1042003]); // ponytail: the only GM gate seen on Maple Island; add more as found

export async function questBook(game = "http://127.0.0.1:3102") {
  const origin = new URL(game).origin;
  const c = await (await fetch(`${origin}/generated/catalog.json`)).json();
  const records = c.quests.records;
  const str = c.quests.strings;
  const item = (id) => c.ui.items[String(id)]?.name?.trim() ?? `item ${id}`;
  const npcName = (id) => str.npc?.[String(id)] ?? `npc ${id}`;
  const mobName = (id) => str.mob?.[String(id)] ?? `mob ${id}`;
  const qName = (id) => records[String(id)]?.name ?? `quest ${id}`;
  const mapName = (id) => c.mapNames[Number(id)] ?? `map ${id}`;

  function verdict(q, level, visiting = new Set()) {
    const start = q.stages[0].check;
    if (!q.supported) return `UNSUPPORTED (${q.blockers.map((b) => b.reason).join("; ")})`;
    const gm = start.items.filter((i) => GM_ITEMS.has(i.id));
    if (gm.length) return `GATED (start needs ${gm.map((i) => item(i.id)).join(", ")} — unobtainable)`;
    visiting.add(q.id);
    // Only "must have started/finished" prerequisites (state ≥ 1) can make a quest unreachable;
    // state 0 means "must NOT have started" (mutually exclusive branches). Cycles count as fine.
    const dead = start.quests.find((p) => p.state >= 1 && !visiting.has(p.id) && records[String(p.id)] &&
      !verdict(records[String(p.id)], null, visiting).startsWith("OK"));
    if (dead) return `UNREACHABLE (prerequisite ${qName(dead.id)} (${dead.id}) is ${verdict(records[String(dead.id)]).split(" ")[0]})`;
    if (level && ((start.lvmin && level < start.lvmin) || (start.lvmax && level > start.lvmax))) return "LEVEL";
    return "OK";
  }

  /** Completion objectives as [{kind, id, name, count}]. */
  const objectives = (q) => {
    const end = q.stages[1]?.check ?? {};
    return [
      ...(end.mobs ?? []).map((m) => ({ kind: "kill", id: m.id, name: mobName(m.id), count: m.count })),
      ...(end.items ?? []).map((i) => ({ kind: "bring", id: i.id, name: item(i.id), count: i.count })),
    ];
  };

  function describe(q, level) {
    const [s0, s1 = { check: {}, act: {} }] = q.stages;
    const lv = `${s0.check.lvmin ?? 1}–${s0.check.lvmax ?? "any"}`;
    const pre = s0.check.quests.map((p) => `${qName(p.id)} (${p.id})`).join(", ");
    const need = objectives(q).map((o) => `${o.kind} ${o.name} ×${o.count}`).join(", ") || "talk to end NPC";
    const gives = [
      s1.act.exp ? `${s1.act.exp} EXP` : null,
      s1.act.money ? `${s1.act.money} mesos` : null,
      ...(s1.act.items ?? []).filter((i) => i.count > 0).map((i) => `${item(i.id)} ×${i.count}`),
    ].filter(Boolean).join(", ");
    return [
      `${q.id} ${q.name}  [${verdict(q, level)}]`,
      `   lv ${lv} · start ${npcName(s0.check.npc)} → end ${npcName(s1.check.npc ?? s0.check.npc)}${pre ? ` · after ${pre}` : ""}`,
      `   do: ${need} · reward: ${gives || "none"}`,
    ].join("\n");
  }

  const forNpc = (id) => Object.values(records).filter((q) => q.stages.some((s) => s.check?.npc === id));
  async function npcsOn(mapId) {
    const m = await (await fetch(new URL(c.maps[String(mapId).padStart(9, "0")].url, origin))).json();
    return [...new Set(m.life.placements.map((p) => m.life.templates[p.template]).filter((t) => t.kind === "npc").map((t) => Number(t.originalId ?? t.id)))];
  }
  return { c, records, verdict, describe, objectives, forNpc, npcsOn, npcName, mobName, item, qName, mapName };
}

if (import.meta.main) {
  const { values: opts } = parseArgs({
    options: {
      game: { type: "string", default: "http://127.0.0.1:3102" },
      npc: { type: "string" },
      map: { type: "string" },
      quest: { type: "string" },
      level: { type: "string" },
    },
    strict: true,
  });
  const book = await questBook(opts.game);
  const level = opts.level ? Number(opts.level) : null;
  if (opts.quest) console.log(book.describe(book.records[opts.quest], level));
  let npcs = [];
  if (opts.npc) npcs = [Number(opts.npc)];
  if (opts.map) npcs = await book.npcsOn(opts.map);
  for (const id of npcs) {
    const qs = book.forNpc(id).filter((q) => !level || book.verdict(q, level) === "OK");
    console.log(`\n== ${book.npcName(id)} (NPC ${id}) — ${qs.length} quest(s)`);
    for (const q of qs) console.log(book.describe(q, level));
  }
}
