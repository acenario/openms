# Client-driven movement with server validation

Ordinary movement belongs to the local client. Packet arrival never restores its position,
replays its inputs or adjusts its interpolation clock. The server accepts a reported path
only after independently reproducing its steps; shared-world actions use that accepted
position. This replaces the earlier deadline/rollback design.

## Native evidence and OpenMS policy

The [original client investigation](native-lag-handling.md#local-character-input-driven-and-immediately-responsive)
recovered a local 30 ms movement controller, previous/current render interpolation,
completed-path sending (`009cb992`, opcode `0x29`) and a separate remote-player path
(`0xb9`). Ordinary remote movement does not route into the local controller. Explicit
local position-setting packets use a different path and reset both positions.

The supplied client directory contains no original server implementation. The validation,
time budgets, JSON wire records and recovery bounds below are OpenMS policy, not recovered
Nexon server code. Original packed path coalescing and its roughly 500 ms send cadence are
not reproduced by this wire adaptation. Windows runtime equivalence remains unverified.

## One movement quantum

1. The browser advances the original-data kernel by 30 ms using local monotonic time. It
   immediately renders the newest previous/current states and cues an accepted jump locally.
   Neither RTT nor the estimated server tick schedules this step.
2. Each completed step reports its input, endpoint `{x,y,vx,vy}`, monotonic `inputSeq`,
   `motionEpoch`, `motionConfig`, `targetTick`, restrictive `movementLocked` flag and at most
   two impulse references. Here `targetTick` orders the character's path; it is **not a
   deadline in the current field clock**. Every catch-up quantum is sent.
3. The server queues at most 128 ordered steps. It reproduces each candidate from its last
   accepted continuation, using its own geometry and issued ability coefficients. Every
   endpoint component must match within `0.000001`, a numerical tolerance, not an accumulating
   position allowance. Client contact IDs, movement coefficients and arbitrary forces are
   never installed.
4. A valid candidate becomes the accepted actor state. Position-dependent item, hit and
   portal checks, persistence and peer publications use that state. Each accepted quantum
   is retained for peer replay, including intermediate contacts in a delivery burst.
   Membership baselines carry the latest peer path cursor in that field, so observers
   cannot replay older burst samples already included in their initial position.
5. A private motion frame acknowledges `inputSeq`. The browser retires that prefix without
   changing either kernel position, held input, local tick, render phase or visible offset.

The server does not advance ordinary movement a second time while waiting for reports.
A late batch therefore extends the last accepted path instead of competing with guessed
neutral-input movement. World combat, cooldowns, drops and transactions retain their own
server clock; no delayed batch replays committed rewards or rewinds another actor.

## Time, capabilities and failure handling

- Server field time supplies movement credit. Accepted 30 ms quanta cannot exceed elapsed
  field ticks; at most four are validated per world tick. Faster client clocks cannot buy
  extra elapsed time. No claimed latency or client timestamp increases this budget.
- A stopped/slower client clock is bounded as well. Debt beyond 128 quanta requests explicit
  connection recovery. At disconnect, unreported time receives bounded neutral integration;
  gravity and inertia continue during reconnect grace. Reconnecting cannot freeze an
  airborne accepted actor indefinitely. Recovery is not classified as proof of cheating.
- Ability changes issue coefficient versions without moving the character. Up to 16 versions
  are retained; a replaced version remains usable for 128 field ticks to cover in-flight
  movement. Unknown/expired versions cannot grant motion.
- Only admitted hits/casts issue impulse grants. At most eight grants exist, each usable once
  within 128 field ticks. A predicted skill references its skill identity before the reply;
  a hit references its issued grant ID. The server supplies the vector and applies it at
  the reported step. Echoes of predicted casts only retire their local tokens.
- Cast admission waits for preceding movement, stopping before that cast's impulse step.
  A movement report preceding its queued cast can wait within the same bounded horizon;
  it grants no position while waiting. A refused impulse cast establishes a fresh movement
  epoch so its unapproved path cannot survive.
- An impossible endpoint, unissued ability/force or replayed grant is rejected before any
  world position is exposed; invalid trajectory enforcement is independent of the optional
  watchdog. The connection is closed instead of entering a loop of position corrections.
- Death, seats, unpredicted server-controlled movement, explicit relocation, field/connection
  replacement and requested recovery establish authoritative continuation. Old-epoch reports
  are discarded. These are separate from ordinary movement acknowledgements.

The browser retains at most 128 outstanding steps and requests recovery after five seconds
without fresh timing, or earlier on history exhaustion. This is finite gap tolerance, not
unlimited disconnected play. Same-domain skill commands still use the existing receipt-bound
queue; rapid casts can exceed its two-second unsent lifetime. This change does not pipeline
transactions or promise that every optimistic action will be admitted.

## Implementation and checks

- [Local motion and rendering](../client/src/online/prediction.js),
  [outgoing journal](../client/src/online/input-journal.js).
- [Trajectory validation](../server/src/movement-stream.js),
  [elapsed time/reconnect](../server/src/movement-clock.js),
  [ability versions](../server/src/movement-configurations.js),
  [one-use forces](../server/src/movement-impulses.js).
- [Closed protocol](server/protocol.md#motion-checkpoints),
  [peer path publication](../server/src/peer-move-stream.js).

```sh
bun test server/test/client-driven-movement.test.js server/test/motion-adoption.test.js server/test/hit-divert-replay.test.js client/test/sync-alignment.test.js client/test/online-transport.test.js
bun server/tools/check-skill-motion.js --scope walk --round-trip-ms 2000 --output /tmp/openms-client-driven-walk
bun server/tools/check-skill-motion.js --scope skills --round-trip-ms 2000 --output /tmp/openms-client-driven-skills
```

The walking scenario holds native direction keys, stalls only upstream traffic for 1.5 seconds,
requires zero ordinary rollback/replay and a matching server-accepted endpoint, then reconnects.
The high-ping skill scenario waits for the existing command queue between casts; its zero-RTT
variant retains the rapid effect-reuse check. Tests cover forged endpoints, both clock bounds,
ordered delayed jumps, issued coefficient changes, impulse replay and denied force claims.
