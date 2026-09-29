import { PROTOCOL } from "../../shared/protocol.js";
import { protocolError } from "../../shared/schema.js";

const MAX_WAITS = PROTOCOL.INPUT_HISTORY;

/** Finish already queued movement before checking a cast's airborne state.
 * The browser's impulse starts immediately; only server admission waits for its
 * own scheduled input. Never advance the field clock from a command or packet. */
export async function awaitSkillInput(world, actor, skillId) {
  const field = actor.field;
  const connection = actor.connection;
  const inputSeq = inputBeforeImpulse(actor, skillId);
  actor.movementBarrier = inputSeq;
  for (let attempt = 0; attempt < MAX_WAITS; attempt++) {
    if (
      actor.field !== field ||
      actor.connection !== connection ||
      actor.retiring
    ) {
      throw protocolError("STALE_FIELD");
    }
    if (world.closed || world.overloaded || field.paused || field.fault) {
      throw protocolError("SERVER_BUSY");
    }
    if (actor.ackInputSeq >= inputSeq) return;
    await new Promise((resolve) => {
      setTimeout(resolve, PROTOCOL.TICK_MS);
    });
  }
  throw protocolError("SERVER_BUSY");
}

function inputBeforeImpulse(actor, skillId) {
  let inputSeq = actor.ackInputSeq ?? 0;
  for (const sample of actor.inputQueue.values()) {
    if (
      sample.impulses.some(
        (entry) => entry.source === "skill" && entry.skillId === skillId,
      )
    ) {
      break;
    }
    inputSeq = Math.max(inputSeq, sample.inputSeq);
  }
  return inputSeq;
}
