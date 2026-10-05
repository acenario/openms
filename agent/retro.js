// Learning-loop retrospective from agent.episodes (Postgres): what works, what fails and why,
// and whether the latest changes made things better or worse.
//   bun agent/retro.js [--name Lumen] [--window 15] [--post]
// Writes knowledge/Agents/<Name>/Retro.md; --post also appends the headline to Learned/Board.md.
// Method: replaced/interrupted episodes are not attempts; trends compare the last N attempts with
// the N before (robust to hot-reload version churn); failure reasons are grouped with digits removed.
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { memory } from "./memory.js";

const { values: o } = parseArgs({
  options: {
    name: { type: "string" },
    window: { type: "string", default: "15" },
    post: { type: "boolean", default: false },
    "database-url": { type: "string" },
  },
  strict: true,
});
const WINDOW = Number(o.window);
const NOT_ATTEMPTS = new Set(["replaced", "interrupted"]);
// The survival planner pauses a goal ("retreated: survival: …") and resumes it as a new episode: a pause, not a failure.
const paused = (r) => r.outcome === "retreated" && /^survival:/.test(r.reason ?? "");
const isAttempt = (r) => !NOT_ATTEMPTS.has(r.outcome) && !paused(r);
const CONTINUOUS = new Set(["follow", "perch", "idle"]);
const m = memory(o["database-url"]);
const pct = (n, d) => (d ? Math.round((100 * n) / d) : null);
const median = (xs) => (xs.length ? xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)] : null);
const reasonKey = (r) => (r ?? "").replace(/\d+(\.\d+)?/g, "#").replace(/\s+/g, " ").trim() || "(no reason)";

function summarize(rows) {
  const ok = rows.filter((r) => r.outcome === "success" || r.outcome === "no-dialogue").length;
  return { n: rows.length, ok, rate: pct(ok, rows.length), medianMs: median(rows.map((r) => r.duration_ms)) };
}

async function retro(agent) {
  const rows = await m.sql`SELECT goal_type, outcome, reason, metrics, version, overlay, duration_ms, started_at
    FROM agent.episodes WHERE agent = ${agent} ORDER BY started_at`;
  const byType = new Map();
  for (const r of rows) (byType.get(r.goal_type) ?? byType.set(r.goal_type, []).get(r.goal_type)).push(r);
  const lines = [], alerts = [], focus = [];
  for (const [type, all] of [...byType].sort((a, b) => b[1].length - a[1].length)) {
    if (CONTINUOUS.has(type)) {
      const ticks = all.reduce((s, r) => s + (r.metrics?.ticks ?? 0), 0);
      const near = all.reduce((s, r) => s + (r.metrics?.nearTicks ?? 0), 0);
      const perched = all.map((r) => r.metrics?.perchMs).filter(Number.isFinite);
      lines.push(`| ${type} | ${all.length} sessions | ${type === "follow" ? `near target ${pct(near, ticks) ?? "–"}% of time` : type === "perch" ? `median time to perch ${median(perched) ?? "–"} ms` : "–"} | | |`);
      continue;
    }
    const attempts = all.filter(isAttempt);
    if (!attempts.length) continue;
    const total = summarize(attempts);
    const recent = summarize(attempts.slice(-WINDOW));
    const before = summarize(attempts.slice(-2 * WINDOW, -WINDOW));
    const trend = before.n >= 3 && recent.n >= 3 ? recent.rate - before.rate : null;
    const failures = new Map();
    for (const r of attempts.slice(-2 * WINDOW)) {
      if (r.outcome === "success" || r.outcome === "no-dialogue") continue;
      const k = `${r.outcome}: ${reasonKey(r.reason)}`;
      failures.set(k, (failures.get(k) ?? 0) + 1);
    }
    const top = [...failures].sort((a, b) => b[1] - a[1]).slice(0, 3);
    // Shown, not scored: restarts (run.js/devwatch/SIGTERM) and disconnects cut goals short through no fault of the brain.
    const interrupted = all.filter((r) => r.outcome === "interrupted").length;
    const pauses = all.filter(paused).length;
    lines.push(`| ${type} | ${total.n} (${total.rate}% ok)${interrupted ? `, +${interrupted} interrupted` : ""}${pauses ? `, +${pauses} paused` : ""} | last ${recent.n}: ${recent.rate}% ok, median ${recent.medianMs} ms | ${trend === null ? "–" : `${trend > 0 ? "+" : ""}${trend} pts`} | ${top.map(([k, n]) => `${n}× ${k}`).join("; ") || "–"} |`);
    if (trend !== null && trend <= -20) alerts.push(`**${type}** success fell ${-trend} points (last ${recent.n}: ${recent.rate}%, before: ${before.rate}%) — check recent brain.js changes.`);
    if (top.length && recent.rate !== null && recent.rate < 70) focus.push(`${type}: fix "${top[0][0]}" (${top[0][1]}× recently)`);
  }
  // Promotion evidence: success per brain version (base brain.js + this agent's overlay hash), newest first.
  // A change earns promotion into the shared brain.js when its version beats the ones before on enough attempts.
  const versionLines = [];
  for (const [type, all] of byType) {
    if (CONTINUOUS.has(type)) continue;
    const byVersion = new Map();
    // Group by the agent's own overlay when it has one (shared-brain edits don't split its buckets);
    // base-only episodes fall back to the combined version.
    for (const r of all.filter(isAttempt)) {
      const key = r.overlay ? `overlay ${r.overlay}` : r.version;
      (byVersion.get(key) ?? byVersion.set(key, []).get(key)).push(r);
    }
    const cells = [...byVersion].reverse().filter(([, rs]) => rs.length >= 3).slice(0, 4)
      .map(([v, rs]) => `${v}: ${summarize(rs).rate}% of ${rs.length}`);
    if (cells.length >= 2) versionLines.push(`| ${type} | ${cells.join(" · ")} |`);
  }
  const lessons = await m.sql`SELECT count(*)::int AS n FROM agent.lessons WHERE agent = ${agent}`;
  // A death is a hurt event at 0 HP (logged before and after the 23:18 "died" event existed).
  const [deaths] = await m.sql`SELECT
      count(*) FILTER (WHERE at > now() - interval '1 hour')::int AS last_hour,
      count(*) FILTER (WHERE at <= now() - interval '1 hour' AND at > now() - interval '2 hours')::int AS hour_before
    FROM agent.events WHERE agent = ${agent} AND kind = 'hurt' AND (data->>'hp')::int = 0`;
  lines.push(`| deaths | last hour: ${deaths.last_hour} | hour before: ${deaths.hour_before} | ${deaths.last_hour - deaths.hour_before > 0 ? "+" : ""}${deaths.last_hour - deaths.hour_before} | |`);
  if (deaths.last_hour >= 2) focus.unshift(`survival: ${deaths.last_hour} deaths in the last hour — fix sustain (potions/Recovery/rope) before anything else`);
  const md = `# ${agent} — retrospective

Generated ${new Date().toISOString().slice(0, 16)}Z by \`bun agent/retro.js --name ${agent}\` from ${rows.length} episodes
(replaced/interrupted are not counted as attempts; trend = last ${WINDOW} attempts vs the ${WINDOW} before). Lessons recorded: ${lessons[0].n}.

| goal | all attempts | recent | trend | top recent failures |
| --- | --- | --- | --- | --- |
${lines.join("\n")}

## By brain version (promotion evidence: newest first, versions with ≥3 attempts)
${versionLines.length ? `| goal | success per version |\n| --- | --- |\n${versionLines.join("\n")}` : "- not enough attempts on two versions yet"}

## Alerts
${alerts.map((a) => `- ${a}`).join("\n") || "- none"}

## Suggested focus
${focus.map((f) => `- ${f}`).join("\n") || "- nothing below 70% recently — pick the slowest goal or a new capability"}
`;
  const dir = join(import.meta.dir, "knowledge", "Agents", agent);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "Retro.md"), md);
  return { agent, alerts, focus, md };
}

const agents = o.name ? [o.name] : (await m.sql`SELECT name FROM agent.agents WHERE name <> 'main' ORDER BY name`).map((r) => r.name);
const results = [];
for (const a of agents) results.push(await retro(a));
for (const r of results) {
  console.log(`\n== ${r.agent}\n${r.md.split("\n").filter((l) => l.startsWith("|") || l.startsWith("- ")).join("\n")}`);
}
if (o.post) {
  const board = join(import.meta.dir, "knowledge", "Learned", "Board.md");
  const head = results.map((r) => `- **${r.agent}**: ${r.alerts.length ? `⚠ ${r.alerts.join(" ")}` : "no regressions"}${r.focus.length ? ` · focus: ${r.focus.join("; ")}` : ""} → [[${r.agent}/Retro]]`).join("\n");
  appendFileSync(board, `\n## ${new Date().toISOString().slice(0, 16).replace("T", " ")} — main → all (retro)\n${head}\n`);
}
await m.close();
