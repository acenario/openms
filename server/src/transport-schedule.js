import { createHash } from "node:crypto";
import { createSimulation } from "../../client/src/physics/simulation.js";
import { combatOperation } from "./combat-rewards.js";
import { createFieldMobs } from "./field-combat.js";
import { npcReferences } from "./interaction-npc-content.js";

const RETRY_MS = 5000;

/**
 * Cosmic EventManager.getTransportationTime → World.getTransportationTime:
 * ceil(time / travelRate), applied only where the authored init() calls it.
 */
function scaled(schedule, time) {
  return time.scaled ? Math.ceil(time.ms / schedule.travelRate) : time.ms;
}

export function transportTimes(schedule) {
  const close = scaled(schedule, schedule.closeTime);
  const begin = scaled(schedule, schedule.beginTime);
  const ride = scaled(schedule, schedule.rideTime);
  return { close, begin, ride, period: begin + ride };
}

/**
 * The authored invasion rolls of the departure taking off at `takeoff`, in
 * Boats.js call order: takeoff's `Math.random() < chance` and jitter draw, then
 * approach's branch draw. OpenMS policy: Cosmic draws Math.random live; these
 * draws are sha256(source, takeoff), so a restart never re-rolls a departure.
 * ponytail: anyone with the vendored source can predict the roll; mix in a
 * persisted server secret if that matters.
 * Returns null when the ride is not invaded, else when its monsters spawn.
 */
export function invasionRoll(schedule, takeoff) {
  const invasion = schedule.invasion;
  if (!invasion) return null;
  const digest = createHash("sha256")
    .update(`${schedule.source.sha256}:${takeoff}`)
    .digest();
  const [roll, jitter, approach] = [0, 4, 8].map(
    (offset) => digest.readUInt32BE(offset) / 0x100000000,
  );
  if (roll >= invasion.chance || approach >= invasion.approachChance) {
    return null;
  }
  return {
    spawnAt:
      takeoff +
      scaled(schedule, invasion.approachTime) +
      Math.trunc(jitter * scaled(schedule, invasion.approachJitter)) +
      scaled(schedule, invasion.spawnDelay),
  };
}

/** The current ride's takeoff while its invasion is on board (spawned, not yet arrived). */
function invadedTakeoff(schedule, now) {
  const { begin, period } = transportTimes(schedule);
  const elapsed = ((now % period) + period) % period;
  if (elapsed < begin) return null;
  const takeoff = now - elapsed + begin;
  const roll = invasionRoll(schedule, takeoff);
  return roll && now >= roll.spawnAt ? takeoff : null;
}

/** Cosmic MapleMap.calcPointBelow(x, y - 1): the nearest floor at or below the point. */
function groundBelow(segments, x, y) {
  let best = null;
  for (const segment of segments) {
    if (segment.dx <= 0 || x < segment.x1 || x > segment.x2) continue;
    const floor = segment.y1 + ((x - segment.x1) * segment.dy) / segment.dx;
    if (floor >= y - 1 && (!best || floor < best.y)) {
      best = { segment, y: floor };
    }
  }
  return best;
}

function invasionMobs(field, rows, takeoff) {
  const templates = field.manifest.life?.templates ?? {};
  // The development-spawn field bound (field-development.js admitMonsterSpawn).
  if (field.mobs.length + field.npcs.size + 256 + rows.length > 2048) {
    return null;
  }
  const placements = rows.map((row, index) => {
    const key = `mob:${String(row.mobId).padStart(7, "0")}`;
    const ground = groundBelow(field.geometry.segments, row.x, row.y);
    if (!templates[key] || !ground) return null;
    const { segment } = ground;
    const y = Math.round(ground.y);
    return {
      id: `invasion:${takeoff}:${index}`,
      kind: "mob",
      template: key,
      source: "transport-invasion",
      authored: {
        id: String(row.mobId).padStart(7, "0"),
        type: "m",
        x: row.x,
        y,
        cy: y,
        fh: segment.id,
        rx0: segment.x1,
        rx1: segment.x2,
        f: 1, // Cosmic Monster default stance 5 faces left.
        hide: 0,
        mobTime: -1,
      },
    };
  });
  if (placements.includes(null)) return null;
  try {
    const mobs = createFieldMobs(
      { life: { placements, templates } },
      createSimulation(field.physics, rows[0]),
    );
    // Authored field-mob policy: unsupported attack families are skipped in combat.
    return mobs.every((mob) => mob.active) ? mobs : null;
  } catch {
    return null;
  }
}

/**
 * Level-triggered Boats invasion: while a ride's invasion is on board, every loaded
 * ride field gets the authored spawns once; when it docks (arrived's
 * killAllMonsters) they are removed without rewards. A field loaded mid-ride
 * receives the same invasion. A missing template or floor, or an inactive
 * template, fails closed: nothing spawns on that map.
 */
function advanceInvasions(world) {
  for (const schedule of world.transports.schedules.values()) {
    if (!schedule.invasion) continue;
    const takeoff = invadedTakeoff(schedule, world.now);
    const maps = Map.groupBy(schedule.invasion.spawns, (row) => row.mapId);
    for (const [mapId, rows] of maps) {
      const field = world.fields.get(`public:${mapId}`);
      if (field && (field.invasion ?? null) !== takeoff) {
        replaceInvasion(world, field, rows, takeoff);
      }
    }
  }
}

function replaceInvasion(world, field, rows, takeoff) {
  for (let index = field.mobs.length - 1; index >= 0; index--) {
    if (field.mobs[index].invasion) field.mobs.splice(index, 1);
  }
  field.invasion = takeoff;
  const mobs = takeoff === null ? [] : invasionMobs(field, rows, takeoff);
  if (!mobs) {
    world.log?.("transport.invasion.unavailable", { map: field.mapId });
  }
  for (const mob of mobs ?? []) {
    mob.invasion = true;
    // Event spawns never respawn: a dead one goes inactive like a development spawn.
    mob.developmentSpawn = true;
    mob.spawnMs = 0;
    mob.opacity = 0;
    field.mobs.push(mob);
  }
  world.invalidateField(field);
}

/**
 * The authored cycle as a pure function of time: scheduleNew (docked, entry open)
 * at 0, the stop callback at close, takeoff at begin, arrived (and the next
 * scheduleNew) at begin + ride. OpenMS policy: the cycle is anchored to the Unix
 * epoch instead of process start, so restarts keep one shared timetable.
 */
export function transportState(schedule, now) {
  const { close, begin, period } = transportTimes(schedule);
  const elapsed = ((now % period) + period) % period;
  const start = now - elapsed;
  return {
    docked: elapsed < begin,
    entry: elapsed < close,
    nextDeparture: elapsed < begin ? start + begin : start + period + begin,
  };
}

/** EventManager.getProperty values the admitted NPC scripts read. */
export function transportProperties(world, now = world.now) {
  const properties = {};
  for (const [name, schedule] of world.transports?.schedules ?? []) {
    const state = transportState(schedule, now);
    properties[name] = {
      docked: String(state.docked),
      entry: String(state.entry),
    };
  }
  return properties;
}

function indexSchedules(published) {
  const schedules = new Map(),
    stops = new Map();
  for (const [name, schedule] of Object.entries(published ?? {})) {
    const times = transportTimes(schedule);
    if (
      schedule.status !== "supported" ||
      !Number.isSafeInteger(schedule.travelRate) ||
      !Object.values(times).every((ms) => Number.isSafeInteger(ms) && ms > 0)
    ) {
      throw new Error(`Invalid transport schedule: ${name}`);
    }
    schedules.set(name, schedule);
    for (const warp of schedule.departures) {
      stops.set(warp.from, { schedule, docked: false, warp });
    }
    for (const warp of schedule.arrivals) {
      stops.set(warp.from, { schedule, docked: true, warp });
    }
  }
  return { schedules, stops };
}

function loadTransports(world) {
  world.transports = { schedules: null, stops: null };
  npcReferences(world)
    .then((references) => {
      Object.assign(
        world.transports,
        indexSchedules(references.data.transportSchedules),
      );
    })
    .catch((error) => {
      // Fail closed: without the published schedule no transport moves anyone.
      world.log?.("transport.unavailable", { reason: error.message });
      Object.assign(world.transports, indexSchedules({}));
    });
}

/**
 * Level-triggered takeoff/arrival. A waiting room while the ship is away is
 * takeoff's warpEveryone plus the waiting room's onUserEnter warpAhead; a ride
 * map while docked is arrived's warpEveryone. Each move is an ordinary
 * server-produced transition, retried after a refusal.
 */
export function advanceTransports(world) {
  if (!world.transports) loadTransports(world);
  const stops = world.transports.stops;
  if (!stops?.size) return;
  advanceInvasions(world);
  for (const actor of world.actors.values()) {
    const stop = actor.field ? stops.get(actor.field.mapId) : undefined;
    if (!stop || !idle(world, actor)) continue;
    if (transportState(stop.schedule, world.now).docked !== stop.docked) {
      continue;
    }
    const { to, randomSpawn, portal } = stop.warp;
    moveActor(
      world,
      actor,
      randomSpawn ? { mapId: to, randomSpawn } : { mapId: to, portal },
    );
  }
}

function idle(world, actor) {
  return (
    actor.state === "active" &&
    !actor.retiring &&
    !actor.deliveryError &&
    !actor.pending &&
    !actor.transition &&
    world.now >= (actor.transportRetryAt ?? 0) &&
    !world.participants.busy(actor)
  );
}

function moveActor(world, actor, destination) {
  const operation = combatOperation(actor, "transport.travel");
  const retry = () => {
    actor.transportRetryAt = world.now + RETRY_MS;
  };
  actor.pending = true;
  actor.pendingOperation = operation.operationId;
  actor.pendingOwner = actor.id;
  world
    .transition(actor, destination, operation)
    .then((receipt) => {
      if (receipt.status !== "committed") retry();
    })
    .catch((error) => {
      actor.admission = error.code ?? "TRANSITION_FAILED";
      retry();
    })
    .finally(() => {
      actor.pending = false;
      actor.pendingOperation = null;
      actor.pendingOwner = null;
      world.participants.signalIdle();
    });
}
