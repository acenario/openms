# Agent runtime (experimental)

Browserless OpenMS players for AI agents. Agents sign in, create their own character and play over the
real game socket — no Chrome, no rendering — built on the client's own `OnlineTransport`,
`OnlinePrediction`, motion kernel and `AvatarVisuals`. Two Claude agents (Lumen and Wayfinder) built and
use this together, coordinating file edits with lock files and teaching each other in game chat.

| File | Role |
| --- | --- |
| `agent.js` | **Body**: socket, supervisor/reconnect, HTTP port, logs (JSONL + Postgres mirror). Hot-reloads `brain.js` without dropping the socket. |
| `brain.js` | **Brain** (hot-reloaded on save): perception, goals (follow, goto, travel, climb, perch, hunt, loot, talk/reply, command), reflexes (vitals: Recovery → potions → retreat to a rope), NPC dialogue reading, map context, HTTP API. |
| `socket-client.js` | Sign in (hashcash) and play over `/api/v1/play`, virtual keys, transition handshake. |
| `create.js` | Deliberate character creation: options → preview sheets → look check → register, roll, create. |
| `render.js` | Headless avatar/NPC renderer (client composition + PNG atlases). |
| `atlas.js` | Map context, NPC portraits, portal routes from the generated catalog. |
| `vault.js` | Generates an Obsidian vault of world knowledge (maps, NPCs, quests, mobs, items) — no model. |
| `memory.js` + `sql/` | Agent memory in Postgres schema `agent` (agents, episodes, events, lessons, messages) and `who`/`find` players. |
| `quests.js`, `questlog.js`, `converse.js`, `drill.js` | Quest availability verdicts, quest log, one-command quest conversations, movement drills (by Wayfinder). |

Requires the dev server and client (`bun run server:dev`, `bun run client:dev`) with extracted assets and
PostgreSQL (for `memory.js`, apply with `bun agent/memory.js migrate`).

```sh
bun agent/create.js --name Lumen --preview                  # agent/logs/creator/*.png
bun agent/create.js --name Lumen --build '{"gender":"Female","hairBase":"Connie Hair","hairColor":"Blond"}' --favor int
bun agent/agent.js --name Lumen --port 3310                 # body; edit brain.js live
curl localhost:3310/context                                 # the map in plain language
curl -X POST localhost:3310/goal -d '{"type":"travel","map":30000}'
curl -X POST localhost:3310/goal -d '{"type":"talk","npc":"Todd"}'
bun agent/memory.js who                                     # online characters and maps
bun agent/vault.js                                          # world knowledge vault
```

Notes for headless clients:
- Shimmed browser touchpoints: `fetch` (cookie jar + `Origin`), `location`, WebSocket headers; the compiled
  identity check is bypassed. Upstream, `OnlineTransport` should accept `{fetch, WebSocket, baseUrl, identity}`.
- The server needs a 30 ms input stream even when idle (`RESYNC_REQUIRED` otherwise).
- A same-field refresh snapshot must not reinstall prediction (rewinds `targetTick` → `INVALID_MESSAGE`).
- Map changes need `transition-ready` after every `prepare` part. Server portal range is ~8 px.
- Quest confirm screens: accept / final acknowledge send `quest.accept` / `quest.claim`, not `npc.answer`.
- Keep attack presses ≥ 600 ms apart: more than 8 queued attack edges throws `RATE_LIMITED` inside the world
  tick (fixed on branch `fix-actor-protocol-errors`).
- `credentials.json`, `logs/`, `.locks/` and `knowledge/` are git-ignored.
