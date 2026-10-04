// Browserless, deliberate character creation for an agent. Steps an agent takes:
//   1. bun agent/create.js --name Lumen --options      option table, by label
//   2. bun agent/create.js --name Lumen --preview      logs/creator/<Gender>-<field>.png sheets
//   3. bun agent/create.js --name Lumen --look --build '{...}'   final-look.png; nothing created
//   4. bun agent/create.js --name Lumen --build '{...}' --favor int   register + roll + create
//      '{...}' = {"gender":"Female","face":"Face 2 of 3","hairBase":"Connie Hair","hairColor":"Blond",
//                 "skin":"Light","top":"Yellow T-Shirt","bottom":"Indigo Miniskirt",
//                 "shoes":"Yellow Rubber Boots","weapon":"Wooden Club"}   (omitted rows = first option)
//   bun agent/create.js --name Lumen --delete         delete this agent's character
// Steps 1–3 never touch the account; only --build (without --look) and --delete sign in.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { signIn } from "./socket-client.js";
import { assets, renderAvatar, sheet } from "./render.js";

const { values: opts } = parseArgs({
  options: {
    name: { type: "string" },
    game: { type: "string", default: "http://127.0.0.1:3102" },
    options: { type: "boolean", default: false },
    preview: { type: "boolean", default: false },
    look: { type: "boolean", default: false },
    delete: { type: "boolean", default: false },
    build: { type: "string" },
    favor: { type: "string", default: "int" },
    // Each roll = 4 per stat + 9 random points (sum 25, max 13); the server keeps only the latest.
    min: { type: "string", default: "8" },
    "max-rolls": { type: "string", default: "60" },
  },
  strict: true,
});
if (!opts.name) throw new Error("--name required");
const OUT = join(import.meta.dir, "logs", "creator");
mkdirSync(OUT, { recursive: true });
const origin = new URL(opts.game).origin;
const catalog = await (await fetch(`${origin}/generated/catalog.json`)).json();
const store = assets(origin);

const ROWS = ["face", "hairBase", "hairColor", "skin", "top", "bottom", "shoes", "weapon"];
const GEAR = ["top", "bottom", "shoes", "weapon"];
const GENDERS = { Male: 0, Female: 1 };

/** Same labels the original create screen shows (authored name, item name, or "Face i of n"). */
function labels(gender) {
  const set = catalog.ui.characterCreate.genders[String(gender)];
  const out = {};
  for (const field of ROWS) {
    out[field] = set[field].map((value, i) => {
      if (GEAR.includes(field)) return { value, label: catalog.ui.items[String(value)].name.trim() };
      const authored = set.names?.[field]?.[String(value)];
      const title = field === "face" ? "Face" : field;
      return { value, label: authored || `${title} ${i + 1} of ${set[field].length}` };
    });
  }
  return out;
}

/** Resolve a {field: label} choice to option values; omitted rows take the first option. */
function resolve(choice) {
  const gender = GENDERS[choice.gender ?? "Male"];
  if (gender === undefined) throw new Error("gender must be Male or Female");
  const table = labels(gender);
  const picked = { gender };
  for (const field of ROWS) {
    const list = table[field];
    const hit = choice[field] ? list.find((o) => o.label === choice[field]) : list[0];
    if (!hit) throw new Error(`no ${field} "${choice[field]}"; options: ${list.map((o) => o.label).join(" | ")}`);
    picked[field] = hit.value;
  }
  return picked;
}

const profileOf = (p) => ({
  gender: p.gender,
  appearance: { skin: p.skin, face: p.face, hair: p.hairBase + p.hairColor },
  equipment: GEAR.map((f) => ({ id: p[f], slot: catalog.ui.avatar.entries[p[f]].equippedSlots[0] })),
});
const draw = (picked) => renderAvatar({ catalog, store, profile: profileOf(picked) });

if (opts.options) {
  for (const [gender, id] of Object.entries(GENDERS)) {
    console.log(`\n${gender}:`);
    for (const [field, list] of Object.entries(labels(id)))
      console.log(`  ${field.padEnd(9)} ${list.map((o) => o.label).join(" | ")}`);
  }
}

if (opts.preview) {
  const index = {};
  for (const [gender, id] of Object.entries(GENDERS)) {
    const base = resolve({ gender });
    for (const [field, list] of Object.entries(labels(id))) {
      const images = [];
      for (const option of list) images.push(await draw({ ...base, [field]: option.value }));
      const file = join(OUT, `${gender}-${field}.png`);
      writeFileSync(file, sheet(images, 3));
      index[`${gender}-${field}`] = list.map((o) => o.label);
      console.log(`[preview] ${file}  (left→right: ${list.map((o) => o.label).join(" | ")})`);
    }
  }
  writeFileSync(join(OUT, "options.json"), JSON.stringify(index, null, 2));
}

if (opts.build && opts.look) {
  const file = join(OUT, "final-look.png");
  writeFileSync(file, sheet([await draw(resolve(JSON.parse(opts.build)))], 4));
  console.log(`[look] ${file} — judge it, then rerun without --look to create`);
}

if (opts.delete || (opts.build && !opts.look)) {
  const { transport } = await signIn({ name: opts.name, game: opts.game, register: true });
  const mine = () => transport.characters.filter((c) => c.name === opts.name);
  if (opts.delete) {
    for (const character of mine()) {
      await transport.deleteCharacter(character.id);
      console.log("[create] deleted", character.name);
    }
  }
  if (opts.build && !opts.look) {
    if (mine().length) throw new Error(`${opts.name} already exists; --delete first`);
    const choice = JSON.parse(opts.build);
    const picked = resolve(choice);
    const favor = opts.favor.toLowerCase();
    const min = Number(opts.min);
    const rolls = [];
    let roll;
    for (let i = 0; i < Number(opts["max-rolls"]); i++) {
      if (i) await Bun.sleep(350); // server allows ~3 rolls/s per session (creation-roll.js)
      roll = await transport.rollCharacterStats();
      rolls.push({ str: roll.str, dex: roll.dex, int: roll.int, luk: roll.luk });
      const best = Math.max(roll.str, roll.dex, roll.int, roll.luk);
      if (roll[favor] >= min && roll[favor] === best) break;
    }
    const created = await transport.createCharacter({
      name: opts.name,
      gender: picked.gender,
      skin: picked.skin,
      face: picked.face,
      hair: picked.hairBase + picked.hairColor, // original packet: base hair + colour suffix
      ...roll,
      top: picked.top,
      bottom: picked.bottom,
      shoes: picked.shoes,
      weapon: picked.weapon,
    });
    const kept = rolls.at(-1);
    writeFileSync(join(OUT, "created.json"), JSON.stringify({ choice, picked, kept, rolls }, null, 2));
    console.log(`[create] ${created.name} created after ${rolls.length} roll(s):`, kept);
  }
  await transport.revoke();
  transport.close();
}
process.exit(0);
