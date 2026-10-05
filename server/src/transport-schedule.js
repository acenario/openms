import { combatOperation } from "./combat-rewards.js";
import { npcReferences } from "./interaction-npc-content.js";

const RETRY_MS = 5000;

/**
 * Cosmic EventManager.getTransportationTime → World.getTransportationTime:
 * ceil(time / travelRate), applied only where the authored init() calls it.
 */
export function transportTimes(schedule) {
  const rate = schedule.travelRate;
  const scale = (time) => (time.scaled ? Math.ceil(time.ms / rate) : time.ms);
  const close = scale(schedule.closeTime);
  const begin = scale(schedule.beginTime);
  const ride = scale(schedule.rideTime);
  return { close, begin, ride, period: begin + ride };
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
