# Agent runtime (experimental)

Browserless OpenMS players for AI agents. Agents sign in, create their own character, and play
over the real game socket — no Chrome, no rendering. Built on the client's own
`OnlineTransport`, `OnlinePrediction`, motion kernel and `AvatarVisuals`; nothing is ported.

| File | Role |
| --- | --- |
| `socket-client.js` | Sign in (hashcash) and play over `/api/v1/play` using the client's transport + predictor, driven by virtual keys |
| `agent.js` | Agent body: reflex loop, local goal endpoint, event + episode logs, auto-reconnect |
| `create.js` | Deliberate character creation: options → preview sheets → look check → register, roll, create |
| `render.js` | Headless avatar renderer (client composition + PNG atlases) for look checks |

Requires a running dev server and client (`bun run server:dev`, `bun run client:dev`) with
extracted assets.

```sh
bun agent/create.js --name Lumen --options
bun agent/create.js --name Lumen --preview            # agent/logs/creator/<Gender>-<field>.png
bun agent/create.js --name Lumen --look --build '{"gender":"Female","hairBase":"Connie Hair","hairColor":"Blond"}'
bun agent/create.js --name Lumen --build '{...same...}' --favor int
bun agent/agent.js --name Lumen                       # goals on http://127.0.0.1:3310

curl -X POST localhost:3310/goal -d '{"type":"say","text":"hi"}'
curl -X POST localhost:3310/goal -d '{"type":"follow","name":"SomePlayer"}'
curl localhost:3310/state
```

Logs: `agent/logs/events.jsonl` (chat, arrivals, hurt, map, online/offline — what the LLM layer
watches), `episodes.jsonl` (one record per goal attempt with metrics and a behaviour-version
hash, for self-improvement), `protocol-trace.jsonl` (frames before a protocol close).

Notes for headless clients:

- Three browser touchpoints are shimmed: `fetch` (cookie jar + `Origin`), `location`, and the
  WebSocket (cookie + `Origin` headers). The compiled asset-identity check is bypassed; an
  upstream version should inject `{fetch, WebSocket, baseUrl, identity}` into `OnlineTransport`.
- The server needs a 30 ms input stream even when idle, or it closes with `RESYNC_REQUIRED`.
- A same-field refresh snapshot (a peer joined/left) must not reinstall prediction — that rewinds
  `targetTick` and the server closes with `INVALID_MESSAGE` (the browser's
  `refreshesInstalledField()` does the same).
- Stat rolls are rate-limited (~3/s per session) and only the latest roll is kept.
- `credentials.json` and `logs/` are git-ignored.
