// Session resumability: save what a model session is doing; brief a fresh session from it + the live world.
//   bun agent/resume.js save --name Lumen --summary "..." [--tasks "a;b"] [--decisions "a;b"] [--notes "..."]
//   bun agent/resume.js brief --name Lumen      → stdout + knowledge/Agents/<Name>/Resume.md
// The brief joins: last checkpoint, the character right now (body HTTP), what's waiting (asks, mail), recent Board
// posts, retro focus and recent lessons. Run `brief` first thing in any new/compacted session; `save` at every
// standup and before signing off.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { memory } from "./memory.js";

const [command] = process.argv.slice(2, 3);
const { values: o } = parseArgs({
  args: process.argv.slice(3),
  options: {
    name: { type: "string" }, summary: { type: "string" }, tasks: { type: "string" }, decisions: { type: "string" },
    notes: { type: "string" }, "database-url": { type: "string" },
  },
  strict: true,
});
if (!o.name) throw new Error("--name required");
const m = memory(o["database-url"]);
const KNOWLEDGE = join(import.meta.dir, "knowledge");
const list = (s) => (s ? s.split(";").map((x) => x.trim()).filter(Boolean) : []);
const ago = (d) => `${Math.round((Date.now() - new Date(d)) / 60000)} min ago`;

if (command === "save") {
  if (!o.summary) throw new Error("--summary required");
  const [row] = await m.sql`INSERT INTO agent.checkpoints (agent, summary, tasks, decisions, notes)
    VALUES (${o.name}, ${o.summary}, string_to_array(${list(o.tasks).join("\x1f")}, chr(31)),
            string_to_array(${list(o.decisions).join("\x1f")}, chr(31)), ${o.notes ?? null}) RETURNING id`;
  console.log(`checkpoint #${row.id} saved for ${o.name}`);
} else if (command === "brief") {
  console.log(await brief(o.name));
} else throw new Error("commands: save | brief");
await m.close();

async function live(port, path) {
  if (!port) return null;
  return fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(3000) }).then((r) => (r.ok ? r.json() : null), () => null);
}

async function brief(name) {
  const [agent] = await m.sql`SELECT name, character, job_plan, personality, port FROM agent.agents WHERE name = ${name}`;
  if (!agent) throw new Error(`unknown agent ${name}`);
  const [cp] = await m.sql`SELECT * FROM agent.checkpoints WHERE agent = ${name} ORDER BY created_at DESC LIMIT 1`;
  const [state, ch] = [await live(agent.port, "/state"), await live(agent.port, "/character")];
  const asks = await m.sql`SELECT id, from_agent, to_agent, title, status FROM agent.requests
    WHERE status IN ('open','claimed') AND (to_agent = ${name} OR from_agent = ${name}) ORDER BY id`;
  const mail = await m.sql`SELECT id, from_agent, subject FROM agent.messages
    WHERE (to_agent = ${name} OR to_agent IS NULL) AND read_at IS NULL AND from_agent <> ${name} ORDER BY id`;
  const lessons = await m.sql`SELECT topic, body FROM agent.lessons WHERE agent = ${name} AND superseded_by IS NULL
    ORDER BY created_at DESC LIMIT 5`;
  const board = existsSync(join(KNOWLEDGE, "Learned", "Board.md"))
    ? readFileSync(join(KNOWLEDGE, "Learned", "Board.md"), "utf8").split("\n").filter((l) => l.startsWith("## ")).slice(-8)
    : [];
  const retroFile = join(KNOWLEDGE, "Agents", name, "Retro.md");
  const focus = existsSync(retroFile) ? readFileSync(retroFile, "utf8").split("## Suggested focus")[1]?.trim().split("\n").slice(0, 3) ?? [] : [];
  const self = state?.world?.self;
  const potions = (ch?.inventory ?? []).filter((i) => /Potion|Apple|Elixir/.test(i.name ?? "")).map((i) => `${i.name} ×${i.quantity}`);
  const overlay = existsSync(join(import.meta.dir, "brains", `${name}.js`));

  const md = `# Resume brief — ${name}
Generated ${new Date().toISOString().slice(0, 16)}Z by \`bun agent/resume.js brief --name ${name}\`. Read this first, then act.

## Who you are
- Character **${agent.character}**${agent.job_plan ? ` · plan: ${agent.job_plan}` : ""}${agent.personality ? ` · ${agent.personality}` : ""}
- Your notes: [[${name}/Profile]] · [[${name}/Journal]] · [[${name}/Retro]] · brain overlay: ${overlay ? `\`brains/${name}.js\`` : "none (base brain.js)"}
- Body API: http://127.0.0.1:${agent.port ?? "?"} (POST /goal, GET /wait, /state, /context, /character)

## Where you left off
${cp ? `Checkpoint #${cp.id}, ${ago(cp.created_at)}:\n> ${cp.summary}\n${cp.tasks.length ? `\n**Open tasks**\n${cp.tasks.map((t) => `- [ ] ${t}`).join("\n")}` : ""}${cp.decisions.length ? `\n\n**Decisions already made (don't re-litigate)**\n${cp.decisions.map((d) => `- ${d}`).join("\n")}` : ""}${cp.notes ? `\n\n**Notes**: ${cp.notes}` : ""}` : "- No checkpoint yet. Read your Journal and the Board, then `resume.js save` one."}

## You, right now in the world
${self ? `- Map ${state.world.mapId} at (${self.x}, ${self.y}) ${self.state} · level ${self.level} · HP ${self.hp}/${self.maxHp} · MP ${self.mp}/${self.maxMp} · AP ${self.ap} · SP ${JSON.stringify(self.sp?.filter(Boolean) ?? [])}
- Current goal: \`${JSON.stringify(state.goal ?? {}).slice(0, 200)}\`
- Mesos ${ch?.mesos ?? "?"} · potions: ${potions.join(", ") || "none"} · beginner SP left ${ch?.beginnerSkillPoints ?? "?"}
- Nearby players: ${(state.world.players ?? []).map((p) => p.name).join(", ") || "none"}` : "- Body offline (or not started). Start it: `bun agent/run.js --name " + name + "`"}

## Waiting on you
${asks.length ? asks.map((a) => `- ask #${a.id} [${a.status}] ${a.from_agent} → ${a.to_agent}: ${a.title}`).join("\n") : "- no open asks"}
${mail.length ? mail.map((x) => `- mail #${x.id} from ${x.from_agent}: ${x.subject}`).join("\n") + `\n- read with \`memory.js inbox --name ${name} --mark-read\`` : "- no unread mail"}

## Recently on the Board
${board.map((h) => `- ${h.slice(3)}`).join("\n") || "- (empty)"}

## Your learning loop
${focus.length ? focus.join("\n") : "- run `bun agent/retro.js --name " + name + "`"}
${lessons.length ? `\nYour latest lessons:\n${lessons.map((l) => `- (${l.topic}) ${l.body.slice(0, 160)}`).join("\n")}` : ""}

## Protocol
Play loop: POST /goal → GET /wait?since=<seq> → react. Standup + \`resume.js save\` every ~20 min and before you stop.
Experiment in your overlay; promote proven changes (Board: promotion checklist). Locks for shared files.
`;
  const dir = join(KNOWLEDGE, "Agents", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "Resume.md"), md);
  return md;
}
