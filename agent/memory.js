// Agent memory in Postgres (schema `agent`, see sql/). Library + CLI.
//   bun agent/memory.js migrate
//   bun agent/memory.js register --name Lumen --port 3310 [--job "Magician"] [--personality "..."]
//   bun agent/memory.js import --name Lumen              JSONL logs -> tables (idempotent per run marker)
//   bun agent/memory.js episodes [--name X] [--type hunt] [--limit 20]   outcome summary per behavior version
//   bun agent/memory.js lesson --name X --topic T --body "..." [--links "A,B"] [--confidence verified]
//   bun agent/memory.js lessons [--topic T] [--name X]
//   bun agent/memory.js mail --name X [--to Y] --subject S --body "..."
//   bun agent/memory.js inbox --name X [--mark-read]
//   bun agent/memory.js who                          online characters and their maps (game DB, read-only)
//   bun agent/memory.js find --player arjun        where a character is / was last seen
//   bun agent/memory.js ask --name X --to OWNER --area A --title T [--body B]   structured request
//   bun agent/memory.js asks [--name X]              open/claimed asks (to X, or all)
//   bun agent/memory.js claim --name X --id N        / done --name X --id N --body "how"
//   bun agent/memory.js decline --name X --id N --body "why"
// --database-url defaults to the local development database.
import { SQL } from "bun";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

const DEFAULT_URL = "postgres://openms:openms_local_only@127.0.0.1:55432/openms";
const DIR = import.meta.dir;

export function memory(url = DEFAULT_URL) {
  const sql = new SQL(url);
  return {
    sql,
    async migrate() {
      for (const file of readdirSync(join(DIR, "sql")).filter((f) => f.endsWith(".sql")).sort())
        await sql.unsafe(readFileSync(join(DIR, "sql", file), "utf8"));
    },
    async register({ name, account, character, port = null, job = null, personality = null }) {
      await sql`INSERT INTO agent.agents (name, account, character, port, job_plan, personality)
        VALUES (${name}, ${account}, ${character}, ${port}, ${job}, ${personality})
        ON CONFLICT (name) DO UPDATE SET port = COALESCE(EXCLUDED.port, agent.agents.port),
          job_plan = COALESCE(EXCLUDED.job_plan, agent.agents.job_plan),
          personality = COALESCE(EXCLUDED.personality, agent.agents.personality), updated_at = now()`;
    },
    async episode(agent, e) {
      await sql`INSERT INTO agent.episodes (agent, version, overlay, goal_type, goal, outcome, reason, metrics, map_id, started_at, duration_ms)
        VALUES (${agent}, ${e.version ?? "?"}, ${e.overlay ?? null}, ${e.goal?.type ?? "?"}, ${e.goal ?? {}}, ${e.outcome}, ${e.reason ?? null},
          ${e.metrics ?? {}}, ${e.mapId ?? null}, ${new Date(e.started ?? Date.parse(e.t))}, ${e.durationMs ?? 0})`;
    },
    async event(agent, record) {
      const { t, kind, ...data } = record;
      await sql`INSERT INTO agent.events (agent, kind, data, at) VALUES (${agent}, ${kind ?? "?"}, ${data}, ${t ? new Date(t) : new Date()})`;
    },
    async lesson(agent, { topic, body, links = [], confidence = "observed" }) {
      // Bun's driver does not bind JS arrays to text[]; send one unit-separator string and split in SQL.
      await sql`INSERT INTO agent.lessons (agent, topic, body, links, confidence)
        VALUES (${agent}, ${topic}, ${body}, string_to_array(${links.join("\u001f")}, chr(31)), ${confidence})`;
    },
    async mail(from, to, subject, body) {
      await sql`INSERT INTO agent.messages (from_agent, to_agent, subject, body) VALUES (${from}, ${to ?? null}, ${subject}, ${body})`;
    },
    /** Read-only view of the game's own character table: where everyone is and who is online. */
    async players(name = null) {
      return sql`SELECT profile->>'name' AS name, map_id,
          (lease_owner IS NOT NULL AND lease_until > now()) AS online, updated_at
        FROM public."character" WHERE deleted_at IS NULL
          AND (${name}::text IS NULL OR lower(profile->>'name') = lower(${name}))
        ORDER BY online DESC, updated_at DESC`;
    },
    async inbox(name, markRead = false) {
      const rows = await sql`SELECT id, from_agent, to_agent, subject, body, created_at FROM agent.messages
        WHERE (to_agent = ${name} OR to_agent IS NULL) AND from_agent <> ${name} AND read_at IS NULL ORDER BY created_at`;
      if (markRead && rows.length) await sql`UPDATE agent.messages SET read_at = now() WHERE id IN ${sql(rows.map((r) => r.id))}`;
      return rows;
    },
    close: () => sql.close(),
  };
}

// ---------- CLI ----------
if (import.meta.main) {
  const [command] = process.argv.slice(2, 3);
  const { values: o } = parseArgs({
    args: process.argv.slice(3),
    options: {
      "database-url": { type: "string", default: DEFAULT_URL },
      name: { type: "string" }, port: { type: "string" }, job: { type: "string" }, personality: { type: "string" },
      type: { type: "string" }, limit: { type: "string", default: "20" },
      topic: { type: "string" }, body: { type: "string" }, links: { type: "string" }, confidence: { type: "string" },
      to: { type: "string" }, player: { type: "string" }, subject: { type: "string" }, "mark-read": { type: "boolean", default: false },
      area: { type: "string" }, title: { type: "string" }, id: { type: "string" }, by: { type: "string" },
    },
    strict: true,
  });
  const m = memory(o["database-url"]);
  const need = (k) => { if (!o[k]) throw new Error(`--${k} required`); return o[k]; };
  const creds = () => JSON.parse(readFileSync(join(DIR, "credentials.json"), "utf8"))[need("name").toLowerCase()];
  try {
    if (command === "migrate") {
      await m.migrate();
      console.log("migrated schema agent");
    } else if (command === "register") {
      const c = creds();
      await m.register({ name: o.name, account: c.account, character: c.character, port: o.port ? Number(o.port) : null, job: o.job, personality: o.personality });
      console.log("registered", o.name);
    } else if (command === "import") {
      const logs = join(DIR, "logs", need("name").toLowerCase());
      const done = await m.sql`SELECT count(*)::int AS n FROM agent.events WHERE agent = ${o.name} AND kind = 'imported'`;
      if (done[0].n) throw new Error(`${o.name} already imported; new records are written live by the body`);
      let episodes = 0, events = 0;
      const lines = (f) => (existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } }) : []);
      for (const e of lines(join(logs, "episodes.jsonl"))) (await m.episode(o.name, e), episodes++);
      for (const e of lines(join(logs, "events.jsonl"))) (await m.event(o.name, e), events++);
      await m.event(o.name, { kind: "imported", episodes, events });
      console.log(`imported ${episodes} episodes, ${events} events for ${o.name}`);
    } else if (command === "episodes") {
      const rows = await m.sql`SELECT agent, goal_type, version, count(*)::int AS n,
          round(100.0 * avg((outcome = 'success')::int))::int AS success_pct,
          round(avg(duration_ms))::int AS avg_ms, sum(coalesce((metrics->>'stuck')::int, 0))::int AS stuck
        FROM agent.episodes WHERE (${o.name ?? null}::text IS NULL OR agent = ${o.name ?? null})
          AND (${o.type ?? null}::text IS NULL OR goal_type = ${o.type ?? null})
        GROUP BY agent, goal_type, version ORDER BY agent, goal_type, max(started_at) DESC LIMIT ${Number(o.limit)}`;
      console.table(rows);
    } else if (command === "lesson") {
      await m.lesson(need("name"), { topic: need("topic"), body: need("body"), links: o.links ? o.links.split(",").map((s) => s.trim()) : [], confidence: o.confidence ?? "observed" });
      console.log("lesson saved");
    } else if (command === "lessons") {
      const rows = await m.sql`SELECT agent, topic, confidence, body, links, created_at FROM agent.lessons
        WHERE superseded_by IS NULL
          AND (${o.topic ?? null}::text IS NULL OR topic ILIKE ${"%" + (o.topic ?? "") + "%"})
          AND (${o.name ?? null}::text IS NULL OR agent = ${o.name ?? null}) ORDER BY created_at DESC LIMIT ${Number(o.limit)}`;
      for (const r of rows) console.log(`[${r.agent} · ${r.topic} · ${r.confidence}] ${r.body}${r.links.length ? `  (${r.links.map((l) => `[[${l}]]`).join(" ")})` : ""}`);
    } else if (command === "supersede") {
      // A wrong lesson stays for history but stops being served: --id <wrong> --by <correcting lesson>
      await m.sql`UPDATE agent.lessons SET superseded_by = ${Number(need("by"))} WHERE id = ${Number(need("id"))}`;
      console.log(`lesson #${o.id} superseded by #${o.by}`);
    } else if (command === "mail") {
      await m.mail(need("name"), o.to ?? null, need("subject"), need("body"));
      console.log("sent");
    } else if (command === "ask") {
      const [row] = await m.sql`INSERT INTO agent.requests (from_agent, to_agent, area, title, body)
        VALUES (${need("name")}, ${need("to")}, ${need("area")}, ${need("title")}, ${o.body ?? ""}) RETURNING id`;
      console.log(`ask #${row.id} → ${o.to} (${o.area}): ${o.title}`);
    } else if (command === "asks") {
      const rows = await m.sql`SELECT id, from_agent, to_agent, area, title, body, status, resolution, created_at FROM agent.requests
        WHERE status IN ('open', 'claimed') AND (${o.name ?? null}::text IS NULL OR to_agent = ${o.name ?? null}) ORDER BY created_at`;
      for (const r of rows) console.log(`#${r.id} [${r.status}] ${r.from_agent} → ${r.to_agent} · ${r.area} · ${r.title}${r.body ? `\n    ${r.body}` : ""}`);
      if (!rows.length) console.log("no open asks");
    } else if (["claim", "done", "decline"].includes(command)) {
      const status = { claim: "claimed", done: "done", decline: "declined" }[command];
      const rows = await m.sql`UPDATE agent.requests SET status = ${status}, resolution = COALESCE(${o.body ?? null}, resolution), updated_at = now()
        WHERE id = ${Number(need("id"))} RETURNING id, from_agent, title`;
      if (!rows.length) throw new Error(`no ask #${o.id}`);
      if (command !== "claim") await m.mail(need("name"), rows[0].from_agent, `ask #${rows[0].id} ${status}: ${rows[0].title}`, o.body ?? "");
      console.log(`ask #${o.id} ${status}`);
    } else if (command === "who" || command === "find") {
      const game = "http://127.0.0.1:3102";
      const names = await fetch(`${game}/generated/catalog.json`).then((r) => r.json()).then((c) => c.mapNames).catch(() => ({}));
      const rows = await m.players(command === "find" ? need("player") : null);
      if (command === "find" && !rows.length) console.log(`no character named ${o.player}`);
      for (const r of rows.filter((r) => command === "find" || r.online))
        console.log(`${r.online ? "online " : "offline"} ${r.name.padEnd(13)} ${names[r.map_id] ?? "?"} (${r.map_id})${r.online ? "" : ` · last seen ${r.updated_at.toISOString().slice(0, 16)}Z`}`);
    } else if (command === "inbox") {
      for (const r of await m.inbox(need("name"), o["mark-read"])) console.log(`#${r.id} ${r.from_agent} → ${r.to_agent ?? "all"} · ${r.subject}\n  ${r.body}`);
    } else {
      throw new Error("commands: migrate | register | import | episodes | lesson | lessons | supersede | mail | inbox | who | find | ask | asks | claim | done | decline");
    }
  } finally {
    await m.close();
  }
}
