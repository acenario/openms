import { PROTOCOL, protocolError } from "../../shared/protocol.js";
import {
  captureMovementSettings,
  sameMovementSettings,
} from "../../shared/movement-settings.js";

const MAX_CONFIGURATIONS = 16;

/** Retain coefficients while in-flight input still names the previous ability revision. */
export function updateMovementConfiguration(actor) {
  const stream = actor.movementStream;
  const latest = stream.configurations.at(-1);
  if (latest && sameMovementSettings(actor.simulation, latest)) return latest;
  const tick = actor.field.tick;
  while (
    stream.configurations.length &&
    stream.configurations[0].expires < tick
  ) {
    stream.configurations.shift();
  }
  if (stream.configurations.length >= MAX_CONFIGURATIONS) {
    throw protocolError("RESYNC_REQUIRED");
  }
  if (latest) latest.expires = tick + PROTOCOL.INPUT_HISTORY;
  const configuration = {
    ...captureMovementSettings(actor.simulation),
    version: (latest?.version ?? 0) + 1,
    expires: Infinity,
  };
  stream.configurations.push(configuration);
  return configuration;
}

export function movementConfiguration(actor, version) {
  for (const configuration of actor.movementStream.configurations) {
    if (
      configuration.version === version &&
      configuration.expires >= actor.field.tick
    ) {
      return configuration;
    }
  }
  return null;
}
