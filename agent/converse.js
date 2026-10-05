// Drive one NPC quest conversation to the end through a running body, so the LLM doesn't spend a
// turn per "next" page. Reads the body's events.jsonl, answers each turn, stops after quest.claim.
//   bun agent/converse.js --name Wayfinder --port 3311 --npc Rain --quest 1009 --answers 0
//   --answers 1,1,3   choice answers in order (quiz questions); omit for quests without choices
// Rules: quest menu -> choose --quest; accept-decline/yes-no -> yes; say with next -> next;
// last say page on a confirm screen -> next (= quest.claim, done); other last page -> close + re-talk.
// Prints one line per turn; exits 0 on claim, 2 when accepted but objectives are unmet ("blocked"),
// 1 on anything it can't handle (read the last turn).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values: o } = parseArgs({
  options: {
    name: { type: "string" }, port: { type: "string", default: "3311" },
    npc: { type: "string" }, quest: { type: "string" }, answers: { type: "string", default: "" },
    steps: { type: "string", default: "30" },
  },
  strict: true,
});
if (!o.name || !o.npc || !o.quest) throw new Error("--name, --npc and --quest required");
const EVENTS = join(import.meta.dir, "logs", o.name.toLowerCase(), "events.jsonl");
const questId = Number(o.quest);
const answers = o.answers ? o.answers.split(",").map(Number) : [];
const lines = () => readFileSync(EVENTS, "utf8").trim().split("\n");
const goal = async (g) => (await fetch(`http://127.0.0.1:${o.port}/goal`, { method: "POST", body: JSON.stringify(g) })).json();

/** Wait for the next npc/npc-closed event after line `from` (ignores chat, map, etc.). */
async function nextTurn(from, ms = 8000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const fresh = lines().slice(from).map((l) => JSON.parse(l)).filter((e) => e.kind === "npc" || e.kind === "npc-closed");
    if (fresh.length) return fresh.at(-1);
    await Bun.sleep(250);
  }
  return null;
}

// Resume a conversation that is already open (last npc turn not followed by npc-closed).
let accepted = false;
let turn = lines().map((l) => JSON.parse(l)).filter((e) => e.kind === "npc" || e.kind === "npc-closed").at(-1) ?? null;
if (turn?.kind === "npc" && turn.npc !== o.npc) turn = null;
for (let step = 0; step < Number(o.steps); step++) {
  const mark = lines().length;
  let g;
  if (turn?.quest?.mode === "blocked") {
    // Accepted, but the objectives (kills/items) aren't met yet: nothing more to say.
    await goal({ type: "reply", answer: "close" });
    console.log("[converse] quest in progress, objectives not met:", turn.text.replace(/\s+/g, " ").slice(0, 160));
    process.exit(2);
  }
  if (!turn || turn.kind === "npc-closed") g = { type: "talk", npc: o.npc };
  else if (turn.type === "choice" && turn.choices?.includes(questId)) g = { type: "reply", answer: "choose", value: questId };
  else if (turn.type === "choice") {
    if (!answers.length) { console.log("[converse] choice with no --answers left:", turn.text); process.exit(1); }
    g = { type: "reply", answer: "choose", value: answers.shift() };
  } else if (turn.type === "accept-decline" || turn.type === "yes-no") g = { type: "reply", answer: "yes" };
  else if (turn.type === "say" && turn.canNext) g = { type: "reply", answer: "next" };
  else if (turn.type === "say" && turn.quest?.mode === "confirm") g = { type: "reply", answer: "next" };
  else if (turn.type === "say") g = { type: "reply", answer: "close" };
  else { console.log("[converse] unhandled turn:", JSON.stringify(turn)); process.exit(1); }
  const r = await goal(g);
  console.log(`[converse] ${g.type} ${g.answer ?? g.npc ?? ""} ${g.value ?? ""} -> ${r.sent ?? ""} ${r.result ?? r.error ?? ""}`);
  if (!r.ok && /no open conversation/.test(r.error ?? "")) { turn = null; continue; } // stale turn from the log: start over
  if (!r.ok) process.exit(1);
  if (r.sent === "quest.claim" && r.result === "OK") {
    await nextTurn(mark, 3000).then((t) => t?.kind === "npc" && t.type === "say" && !t.canNext && goal({ type: "reply", answer: "close" }));
    console.log("[converse] claimed quest", questId);
    process.exit(0);
  }
  turn = await nextTurn(mark, g.type === "talk" ? 15000 : 8000);
  if (r.sent === "quest.accept" && r.result === "OK") accepted = true;
  if (!turn && accepted) { console.log("[converse] quest accepted; this NPC has nothing more — finish it at the end NPC (questlog.js)"); process.exit(2); }
  if (!turn) { console.log("[converse] no reply from NPC (dead quest? check quests.js)"); process.exit(1); }
  if (turn.kind === "npc") console.log(`   ${turn.npc} [${turn.type}${turn.quest ? ` ${turn.quest.mode}/${turn.quest.stage}` : ""}] ${turn.text.replace(/\s+/g, " ").slice(0, 140)}`);
}
console.log("[converse] step limit reached");
process.exit(1);
