// Rename a character (players and agents). The character must be offline (no lease).
//   bun agent/rename.js --from arjun1 --to arjun
// Same rule as creation (server/src/character-creation.js: /^[A-Za-z0-9]{4,13}$/, unique case-insensitively among
// active characters — the character_active_name index enforces it too). Only the live profile name changes; history
// (character_op_log, character_snapshot, item_history) keeps the old name on purpose. If the character belongs to an
// agent, agent.agents.character and credentials.json follow. Agents: stop your body first (run.js), rename, restart.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { SQL } from "bun";

const { values: o } = parseArgs({
  options: {
    from: { type: "string" }, to: { type: "string" },
    "database-url": { type: "string", default: "postgres://openms:openms_local_only@127.0.0.1:55432/openms" },
  },
  strict: true,
});
if (!o.from || !o.to) throw new Error("--from and --to required");
if (!/^[A-Za-z0-9]{4,13}$/.test(o.to)) throw new Error(`"${o.to}" is not a valid name (4–13 letters/digits)`);

const sql = new SQL(o["database-url"]);
try {
  await sql.begin(async (tx) => {
    const [c] = await tx`SELECT id, lease_until > clock_timestamp() AS online FROM character
      WHERE lower(profile->>'name') = lower(${o.from}) AND deleted_at IS NULL FOR UPDATE`;
    if (!c) throw new Error(`no active character named ${o.from}`);
    if (c.online) throw new Error(`${o.from} is online — log out (agents: stop the body) and retry`);
    const [taken] = await tx`SELECT 1 FROM character WHERE lower(profile->>'name') = lower(${o.to}) AND deleted_at IS NULL AND id <> ${c.id}`;
    if (taken) throw new Error(`name ${o.to} is taken`);
    await tx`UPDATE character SET profile = jsonb_set(profile, '{name}', to_jsonb(${o.to}::text)), updated_at = clock_timestamp() WHERE id = ${c.id}`;
    // Agent bookkeeping (no-op for human players).
    await tx`UPDATE agent.agents SET character = ${o.to}, updated_at = now() WHERE lower(character) = lower(${o.from})`;
  });
} finally {
  await sql.close();
}
const CREDENTIALS = join(import.meta.dir, "credentials.json");
if (existsSync(CREDENTIALS)) {
  const all = JSON.parse(readFileSync(CREDENTIALS, "utf8"));
  const entry = Object.values(all).find((a) => a.character?.toLowerCase() === o.from.toLowerCase());
  if (entry) (entry.character = o.to), writeFileSync(CREDENTIALS, JSON.stringify(all, null, 2));
}
console.log(`renamed ${o.from} → ${o.to}`);
