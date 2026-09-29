// Deterministic peer-latency trace: does the drawn remote actor follow the true trajectory
// when samples traverse a slow link? Runs the real shared physics kernel for the peer and the
// real client RemotePlayerPath replay, with no browser, account or database.
//
// Usage:
//   bun client/tools/peer-latency-trace.js [--interval 1] [--gated] [--one-way-ms 250]
//     --interval  ticks between samples (1 = the native per-tick move stream, 3 = a 90 ms view)
//     --gated     serialize samples behind an application-level ack (round-trip bound)
//     --one-way-ms  delivery delay for one leg
// Output: a JSON summary on stdout. Raw runs belong outside the repository.
import {
  createSimulation,
  advanceSimulation,
} from "../src/physics/simulation.js";
import { attachGround, prepareSegments } from "../src/physics/geometry.js";
import { prepareBounds } from "../src/physics/bounds.js";
import { parseFlags } from "./source-options.js";
import { RemotePlayerPath } from "../src/online/remote-player-path.js";

const TICK_MS = 30;
const FRAME_MS = 15;
const TICKS = 220;

const flags = parseFlags(process.argv.slice(2), {
  interval: { type: "string" },
  gated: { type: "boolean" },
  "one-way-ms": { type: "string" },
  help: { type: "boolean" },
});
if (flags.help) {
  console.log(
    "bun client/tools/peer-latency-trace.js [--interval 1] [--gated] [--one-way-ms 250]",
  );
  process.exit(0);
}
const INTERVAL = Number(flags.interval ?? 1);
const GATED = Boolean(flags.gated);
const ONE_WAY_MS = Number(flags["one-way-ms"] ?? 250);
if (
  !Number.isInteger(INTERVAL) ||
  INTERVAL < 1 ||
  INTERVAL > 128 ||
  !Number.isInteger(ONE_WAY_MS) ||
  ONE_WAY_MS < 0 ||
  ONE_WAY_MS > 2000
) {
  throw new Error("interval must be 1..128 ticks and one-way-ms 0..2000");
}

const mapFile = (
  await Array.fromAsync(
    new Bun.Glob("../public/generated/maps/*.json").scan({
      cwd: import.meta.dir,
      absolute: true,
    }),
  )
).sort()[0];
if (!mapFile) throw new Error("No generated map; run the extractor first");
const globals = (await Bun.file(mapFile).json()).physics.globals;

function flat(id, y, x1, x2) {
  return { id, layer: 1, group: 0, x1, y1: y, x2, y2: y, prev: 0, next: 0 };
}

// Lower platform, upper platform, and a rope joining them at x=200.
const FOOTHOLDS = [flat(1, 0, -500, 500), flat(2, -200, 150, 600)];
const LADDERS = [
  { id: 1, x: 200, y1: -200, y2: 0, ladder: true, uf: false, page: 1 },
];
const MAP = { fieldLimit: 0 };

function held(over = {}) {
  return {
    left: false,
    right: false,
    up: false,
    down: false,
    jump: false,
    attack: false,
    jumpPressed: false,
    ...over,
  };
}

/** The peer walks to the rope, climbs it, jumps off at the top, then falls and lands. */
function script(tick) {
  if (tick < 53) return held({ right: true });
  if (tick < 125) return held({ up: true });
  if (tick === 125) return held({ up: true, jump: true, jumpPressed: true });
  return held();
}

function playerMotion(sim) {
  const settings = sim.effectiveSettings;
  return {
    state: sim.state,
    gravity: settings.gravityAcc * settings.gravity,
    fallSpeed: settings.fallSpeed * settings.gravity,
    ignoredFoothold: sim.ignoredFootholdId,
    contactLayer: sim.contactLayer,
    contactGroup: sim.contactGroup,
    ladder: sim.ladder
      ? { x: sim.ladder.x, top: sim.ladder.y1, bottom: sim.ladder.y2 }
      : null,
  };
}

function snapshot(sim) {
  return {
    id: "peer",
    kind: "player",
    position: { x: sim.x, y: sim.y },
    velocity: { x: sim.vx, y: sim.vy },
    foothold: sim.foothold?.id ?? null,
    facing: sim.facing,
    action: 1,
    actionStartTick: 1,
    combatState: { phase: "idle", phaseMs: 0 },
    playerMotion: playerMotion(sim),
  };
}

function buildTrace() {
  const sim = createSimulation(
    {
      schemaVersion: 1,
      globals,
      footholds: FOOTHOLDS.map((entry) => ({ ...entry })),
      ladders: LADDERS.map((entry) => ({ ...entry })),
      map: MAP,
    },
    { x: 0, y: 0 },
  );
  attachGround(sim, sim.geometry.byId.get(1));
  sim.x = 0;
  sim.previousX = 0;
  sim.y = 0;
  sim.previousY = 0;
  const trace = [];
  const samples = [];
  let nextSendAt = 0;
  for (let tick = 0; tick < TICKS; tick++) {
    advanceSimulation(sim, script(tick), TICK_MS);
    trace.push({
      x: sim.x,
      y: sim.y,
      state: sim.state,
      foothold: sim.foothold?.id ?? null,
    });
    if (tick % INTERVAL === INTERVAL - 1) {
      const at = (tick + 1) * TICK_MS;
      if (!GATED || at >= nextSendAt) {
        samples.push({ tick: tick + 1, at, entity: snapshot(sim) });
        if (GATED) nextSendAt = at + ONE_WAY_MS * 2;
      }
    }
  }
  return { trace, samples };
}

function floorYAt(segments, x) {
  let best = null;
  for (const entry of segments) {
    if (x < Math.min(entry.x1, entry.x2) - 1) continue;
    if (x > Math.max(entry.x1, entry.x2) + 1) continue;
    const y =
      entry.y1 +
      ((x - entry.x1) * (entry.y2 - entry.y1)) / (entry.x2 - entry.x1);
    if (best === null || y > best) best = y;
  }
  return best;
}

function replay(trace, samples, segments) {
  const motion = new RemotePlayerPath(samples[0].entity, 0, 0);
  motion.x = samples[0].entity.position.x;
  motion.y = samples[0].entity.position.y;
  let index = 0;
  let penetration = 0;
  let error = 0;
  let worst = null;
  for (let now = 0; now <= TICKS * TICK_MS; now += FRAME_MS) {
    while (index < samples.length && samples[index].at + ONE_WAY_MS <= now) {
      const sample = samples[index];
      motion.append(
        {
          ...sample.entity,
          tick: sample.tick,
          moveType: 0,
          durationMs: (sample.tick - (samples[index - 1]?.tick ?? 0)) * TICK_MS,
        },
        sample.at + ONE_WAY_MS,
      );
      index++;
    }
    const pose = motion.sample(now);
    const contentMs = now - 60 - ONE_WAY_MS;
    if (contentMs <= 0) continue;
    const tick = Math.max(
      0,
      Math.min(trace.length - 1, Math.round(contentMs / TICK_MS)),
    );
    const truth = trace[tick];
    const floorY = floorYAt(segments.segments, pose.x);
    if (truth.state === "ground" && floorY !== null) {
      penetration = Math.max(penetration, pose.y - floorY);
      const distance = Math.hypot(pose.x - truth.x, pose.y - truth.y);
      if (distance > error) {
        error = distance;
        worst = {
          atMs: now,
          drawn: { x: pose.x, y: pose.y },
          true: { x: truth.x, y: truth.y },
        };
      }
    }
  }
  return { penetration, error, worst, replay: motion.snapshot() };
}

const { trace, samples } = buildTrace();
const result = replay(trace, samples, prepareBoundsGeometry());
console.log(
  JSON.stringify(
    {
      intervalTicks: INTERVAL,
      gated: GATED,
      oneWayMs: ONE_WAY_MS,
      samples: samples.length,
      replay: result.replay,
      maxPenetrationPx: Number(result.penetration.toFixed(3)),
      maxReconstructionErrorPx: Number(result.error.toFixed(3)),
      worst: result.worst,
    },
    null,
    2,
  ),
);

function prepareBoundsGeometry() {
  const geometry = prepareSegments(FOOTHOLDS.map((entry) => ({ ...entry })));
  geometry.bounds = prepareBounds(geometry.segments, MAP);
  return geometry;
}
